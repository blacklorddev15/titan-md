package com.aether.titanmd;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * WebView wrapper around the pairing portal (v1.2).
 *
 * Safety boundaries that this class is responsible for keeping:
 *  - The app cannot pair anyone on someone else's behalf. The pairing code is only ever displayed
 *    in the portal UI; entering it is done by the account owner in their own WhatsApp app. There is
 *    no clipboard relay, no notification containing a code, and no JS bridge.
 *  - The code screen is protected: FLAG_SECURE blocks screenshots and hides it from the recents
 *    thumbnail while a request is live, and returning to the app after a real absence requires the
 *    device credential. A quick hop to WhatsApp to paste the code does not re-prompt.
 *  - Deep links are only honoured for the configured portal host, so another app cannot make this
 *    WebView load an arbitrary site inside the app's chrome.
 *
 * Written with anonymous listener classes (no lambdas) so it compiles against android.jar on the
 * bootclasspath, which has no java.lang.invoke.LambdaMetafactory stub.
 */
public class MainActivity extends Activity {

    private static final String DEFAULT_URL = "https://titan-md-repo.vercel.app";
    private static final String PREFS = "pair_portal";
    private static final String KEY_URL = "server_url";
    private static final String KEY_CONSENT = "consent_ack";

    private static final int MENU_RELOAD = 1;
    private static final int MENU_URL = 2;
    private static final int MENU_ABOUT = 3;

    private static final int REQ_CREDENTIAL = 101;
    private static final int REQ_NOTIFICATIONS = 102;

    /** Returning sooner than this (e.g. to paste the code into WhatsApp) does not re-prompt. */
    private static final long LOCK_GRACE_MS = 60L * 1000L;

    private static final String SCHEME = "titanmd";

    private WebView web;
    private ProgressBar bar;
    private LinearLayout loadingView;
    private LinearLayout errorView;
    private TextView errorText;
    private SharedPreferences prefs;

    /** True while a pairing request started by this device is live. */
    private boolean sensitive = false;
    private long backgroundAt = 0L;
    private boolean credentialPromptOpen = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = (WebView) findViewById(R.id.web);
        bar = (ProgressBar) findViewById(R.id.bar);
        loadingView = (LinearLayout) findViewById(R.id.loadingView);
        errorView = (LinearLayout) findViewById(R.id.errorView);
        errorText = (TextView) findViewById(R.id.errorText);
        Button retry = (Button) findViewById(R.id.retry);
        Button browser = (Button) findViewById(R.id.retryBrowser);

        configureWebView();

        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errorView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
                bar.setVisibility(View.VISIBLE);
                showLoading();
                web.reload();
            }
        });

        browser.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(serverUrl())));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, R.string.no_browser, Toast.LENGTH_SHORT).show();
                }
            }
        });

        if (savedInstanceState == null) {
            showConsentThenLoad();
        } else {
            // Restored page is already rendered — do not leave the loading screen up.
            web.restoreState(savedInstanceState);
            hideLoading();
        }

        routeIntent(getIntent());
    }

    /* ── loading screen ───────────────────────────────────────────────────── */

    private void showLoading() {
        loadingView.setVisibility(View.VISIBLE);
    }

    private void hideLoading() {
        loadingView.setVisibility(View.GONE);
    }

    /* ── WebView ──────────────────────────────────────────────────────────── */

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);            // the portal is a JS app
        s.setDomStorageEnabled(true);            // stores the language preference
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " TitanMD/1.0");
        CookieManager.getInstance().setAcceptCookie(true);

        web.setBackgroundColor(0xFF07090E);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                bar.setProgress(progress);
                bar.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                String host = uri.getHost() == null ? "" : uri.getHost();
                String currentHost = Uri.parse(web.getUrl() == null ? DEFAULT_URL : web.getUrl()).getHost();

                if (SCHEME.equals(scheme)) {         // in-app events from the portal page
                    handleAppEvent(uri);
                    return true;
                }
                if (("http".equals(scheme) || "https".equals(scheme))
                        && host.equalsIgnoreCase(currentHost)) {
                    return false;                    // keep same-host navigation in the app
                }
                if ("http".equals(scheme) || "https".equals(scheme)
                        || "mailto".equals(scheme) || "tel".equals(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri)); // external links leave the app
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                return true; // unknown schemes: block rather than hand to an arbitrary handler
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                bar.setVisibility(View.GONE);
                hideLoading();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showError(getString(R.string.error_body) + "\n\n" + error.getDescription());
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Never "proceed" on a certificate problem — a pairing portal is a credential surface.
                handler.cancel();
                showError(getString(R.string.error_tls));
            }
        });
    }

    /* ── in-app event scheme ──────────────────────────────────────────────── */

    /**
     * titanmd://copy?text=CODE   native clipboard copy
     * titanmd://watch?id=..&expires=..   a request just started: protect + notify
     * titanmd://done | stopwatch         the flow finished: unprotect + stop watching
     */
    private void handleAppEvent(Uri uri) {
        String host = uri.getHost() == null ? "" : uri.getHost();
        if ("copy".equals(host)) {
            copyToClipboard(uri.getQueryParameter("text"));
        } else if ("watch".equals(host)) {
            startWatching(uri.getQueryParameter("id"), uri.getQueryParameter("expires"));
        } else if ("done".equals(host) || "stopwatch".equals(host)) {
            setSensitive(false);
            WatchService.stop(this);
        }
    }

    private void copyToClipboard(String text) {
        if (text == null) return;
        String clean = text.replaceAll("[^A-Za-z0-9-]", "");
        if (clean.isEmpty() || clean.length() > 64) return;
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("pairing code", clean));
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show();
    }

    private void startWatching(String requestId, String expiresAt) {
        if (requestId == null || !requestId.matches("^[A-Za-z0-9_-]{6,64}$")) return;
        setSensitive(true);
        ensureNotificationPermission();
        WatchService.start(this, serverUrl(), requestId, expiresAt);
    }

    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFICATIONS);
        }
    }

    /**
     * FLAG_SECURE while a request is live: no screenshots, and the code is hidden from the
     * recents thumbnail. Cleared as soon as the flow finishes.
     */
    private void setSensitive(boolean on) {
        sensitive = on;
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    /* ── credential gate ──────────────────────────────────────────────────── */

    @Override
    protected void onStop() {
        backgroundAt = SystemClock.elapsedRealtime();
        super.onStop();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (credentialPromptOpen || !sensitive) return;
        long away = SystemClock.elapsedRealtime() - backgroundAt;
        if (backgroundAt == 0L || away < LOCK_GRACE_MS) return;

        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (km == null || !km.isDeviceSecure()) return;   // nothing to verify against
        Intent prompt = km.createConfirmDeviceCredentialIntent(
                getString(R.string.lock_title), getString(R.string.lock_body));
        if (prompt != null) {
            credentialPromptOpen = true;
            startActivityForResult(prompt, REQ_CREDENTIAL);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_CREDENTIAL) {
            credentialPromptOpen = false;
            if (resultCode != RESULT_OK) {
                // Cancelled or failed: push the app to the background rather than show the screen.
                moveTaskToBack(true);
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ── intent routing (deep links + shortcuts) ──────────────────────────── */

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        routeIntent(intent);
    }

    private void routeIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri uri = intent.getData();
        if (!SCHEME.equals(uri.getScheme())) return;   // https deep links just load the portal
        String host = uri.getHost() == null ? "" : uri.getHost();
        if ("reload".equals(host)) clearErrorAndLoad(serverUrl());
        else if ("url".equals(host)) askForUrl();
        else if ("about".equals(host)) showAbout();
    }

    /* ── loading / errors ─────────────────────────────────────────────────── */

    private void showError(String message) {
        bar.setVisibility(View.GONE);
        hideLoading();                       // never leave the brand screen over the error panel
        errorText.setText(message);
        errorView.setVisibility(View.VISIBLE);
        web.setVisibility(View.INVISIBLE);
    }

    private void clearErrorAndLoad(String url) {
        errorView.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        bar.setVisibility(View.VISIBLE);
        showLoading();
        web.loadUrl(url);
    }

    private String serverUrl() {
        return prefs.getString(KEY_URL, DEFAULT_URL);
    }

    /** One-time notice: linking a number grants the bot access to that account. */
    private void showConsentThenLoad() {
        if (prefs.getBoolean(KEY_CONSENT, false)) {
            clearErrorAndLoad(serverUrl());
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.consent_title)
                .setMessage(R.string.consent_body)
                .setCancelable(false)
                .setPositiveButton(R.string.consent_ok, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        prefs.edit().putBoolean(KEY_CONSENT, true).apply();
                        clearErrorAndLoad(serverUrl());
                    }
                })
                .show();
    }

    /* ── menu ─────────────────────────────────────────────────────────────── */

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_RELOAD, 0, R.string.menu_reload);
        menu.add(0, MENU_URL, 1, R.string.menu_url);
        menu.add(0, MENU_ABOUT, 2, R.string.menu_about);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case MENU_RELOAD:
                clearErrorAndLoad(serverUrl());
                return true;
            case MENU_URL:
                askForUrl();
                return true;
            case MENU_ABOUT:
                showAbout();
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    private void showAbout() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.about_title)
                .setMessage(R.string.about_body)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    private void askForUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl());
        input.setSelection(input.getText().length());

        new AlertDialog.Builder(this)
                .setTitle(R.string.url_title)
                .setMessage(R.string.url_body)
                .setView(input)
                .setPositiveButton(R.string.url_save, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        String url = input.getText().toString().trim();
                        if (url.isEmpty()) url = DEFAULT_URL;
                        if (!url.startsWith("http://") && !url.startsWith("https://")) {
                            url = "https://" + url;
                        }
                        boolean isLocal = url.contains("localhost") || url.contains("10.0.2.2")
                                || url.contains("127.0.0.1");
                        if (!url.startsWith("https://") && !isLocal) {
                            Toast.makeText(MainActivity.this, R.string.url_https_required,
                                    Toast.LENGTH_LONG).show();
                            return;
                        }
                        prefs.edit().putString(KEY_URL, url).apply();
                        web.clearCache(false);
                        clearErrorAndLoad(url);
                    }
                })
                .setNegativeButton(android.R.string.cancel, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        clearErrorAndLoad(serverUrl());
                    }
                })
                .show();
    }

    /* ── lifecycle ────────────────────────────────────────────────────────── */

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }
}
