package com.aether.titanmd;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Polls the portal for a pairing request that was started in this app's WebView, so the user gets
 * notified when the code is ready even if the app is in the background.
 *
 * Deliberate constraints:
 *  - The notification never contains the pairing code. Notifications render on the lock screen,
 *    which would defeat the FLAG_SECURE screen protection in MainActivity. The notification says
 *    the code is ready and opens the app; the code itself is only ever shown in the app.
 *  - The service only accepts a request id that arrived from the portal page running on the
 *    configured server host. There is no interface for watching, forwarding or relaying a request
 *    that belongs to somebody else.
 *  - It polls a single request, gives up on connected/failed/expired, and self-terminates after a
 *    hard cap (MAX_WATCH_MS) so it can never become a permanent background poller.
 */
public class WatchService extends Service {

    public static final String EXTRA_BASE_URL = "base_url";
    public static final String EXTRA_REQUEST_ID = "request_id";
    public static final String EXTRA_EXPIRES_AT = "expires_at";

    private static final String CHANNEL_WATCH = "pairing_watch";
    private static final String CHANNEL_ALERT = "pairing_alerts";
    private static final int NOTIF_WATCH = 1001;
    private static final int NOTIF_ALERT = 1002;

    private static final long POLL_MS = 3000L;
    private static final long MAX_WATCH_MS = 15L * 60L * 1000L;   // hard cap
    private static final long HTTP_TIMEOUT_MS = 10000L;

    private static final Pattern ID_OK = Pattern.compile("^[A-Za-z0-9_-]{6,64}$");
    private static final Pattern JSON_FIELD_TEMPLATE =
            Pattern.compile("\"%s\"\\s*:\\s*\"([^\"]*)\"");

    private volatile boolean running = false;
    private Thread worker;

    /** Start (or restart) watching a request. Always called from a visible app. */
    public static void start(Context ctx, String baseUrl, String requestId, String expiresAtIso) {
        Intent i = new Intent(ctx, WatchService.class);
        i.putExtra(EXTRA_BASE_URL, baseUrl);
        i.putExtra(EXTRA_REQUEST_ID, requestId);
        i.putExtra(EXTRA_EXPIRES_AT, expiresAtIso == null ? "" : expiresAtIso);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, WatchService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String baseUrl = intent == null ? null : intent.getStringExtra(EXTRA_BASE_URL);
        String requestId = intent == null ? null : intent.getStringExtra(EXTRA_REQUEST_ID);
        String expiresAt = intent == null ? "" : intent.getStringExtra(EXTRA_EXPIRES_AT);

        if (baseUrl == null || requestId == null || !ID_OK.matcher(requestId).matches()
                || !isAllowedBase(baseUrl)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        createChannels();
        startForegroundCompat(buildWatchNotification(getString(R.string.watch_running)));

        stopWorker();
        running = true;
        final long startedAt = SystemClock.elapsedRealtime();
        final long expiresMs = parseTime(expiresAt);
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                pollLoop();
            }

            private void pollLoop() {
                try {
                    while (running) {
                        if (SystemClock.elapsedRealtime() - startedAt > MAX_WATCH_MS) break;
                        String body = fetchStatus(baseUrl, requestId);
                        if (body == null) {
                            sleep(POLL_MS * 2);
                            continue;
                        }
                        String status = field(body, "status");
                        if ("code_generated".equals(status)) {
                            alert(getString(R.string.notif_ready_title),
                                    getString(R.string.notif_ready_body));
                            break;
                        }
                        if ("connected".equals(status)) {
                            alert(getString(R.string.notif_connected_title),
                                    getString(R.string.notif_connected_body));
                            break;
                        }
                        if ("failed".equals(status)) {
                            alert(getString(R.string.notif_failed_title),
                                    getString(R.string.notif_failed_body));
                            break;
                        }
                        if ("expired".equals(status)) break;
                        if (expiresMs > 0 && System.currentTimeMillis() > expiresMs) break;
                        sleep(POLL_MS);
                    }
                } finally {
                    stopSelf();
                }
            }
        }, "pair-watch");
        worker.start();

        return START_NOT_STICKY;
    }

    /** Only https (or a loopback dev host) — the same rule the WebView enforces. */
    private static boolean isAllowedBase(String baseUrl) {
        if (baseUrl.startsWith("https://")) return true;
        return baseUrl.startsWith("http://localhost") || baseUrl.startsWith("http://127.0.0.1")
                || baseUrl.startsWith("http://10.0.2.2");
    }

    private static long parseTime(String iso) {
        if (iso == null || iso.isEmpty()) return 0L;
        try {
            // e.g. 2026-09-15T05:18:13.179Z
            java.text.SimpleDateFormat f =
                    new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            String trimmed = iso.length() > 19 ? iso.substring(0, 19) : iso;
            return f.parse(trimmed).getTime();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private String fetchStatus(String baseUrl, String requestId) {
        HttpURLConnection c = null;
        try {
            URL url = new URL(baseUrl + "/api/status?id=" + requestId);
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout((int) HTTP_TIMEOUT_MS);
            c.setReadTimeout((int) HTTP_TIMEOUT_MS);
            c.setRequestMethod("GET");
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "TitanMD/1.0 (Android)");
            if (c.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return sb.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String field(String json, String key) {
        Matcher m = Pattern.compile(String.format(JSON_FIELD_TEMPLATE.pattern(), key)).matcher(json);
        return m.find() ? m.group(1) : "";
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_WATCH,
                getString(R.string.channel_watch), NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ALERT,
                getString(R.string.channel_alert), NotificationManager.IMPORTANCE_HIGH));
    }

    private Notification buildWatchNotification(String text) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_WATCH)
                : new Notification.Builder(this);
        return b.setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_titan)
                .setOngoing(true)
                .setContentIntent(contentIntent())
                .build();
    }

    private void alert(String title, String body) {
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ALERT)
                : new Notification.Builder(this);
        Notification n = b.setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_titan)
                .setAutoCancel(true)
                .setContentIntent(contentIntent())
                .build();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ALERT, n);
    }

    private PendingIntent contentIntent() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, open, flags);
    }

    private void startForegroundCompat(Notification n) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_WATCH, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_WATCH, n);
        }
    }

    private void stopWorker() {
        running = false;
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
    }

    @Override
    public void onDestroy() {
        stopWorker();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
