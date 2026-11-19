package io.github.direkiwi.potfit;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.text.InputType;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * potfit in a WebView: the app is the web app, served by your potfit server. On first start it
 * asks for the server's address; the launcher icon's "Change server" shortcut asks again.
 */
public class MainActivity extends Activity {
    private static final String CHANGE_SERVER = "io.github.direkiwi.potfit.CHANGE_SERVER";
    private static final int PICK_FILES = 1;

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> pickedFiles;
    /** Saved credentials already offered for the current page, so a wrong pair asks again. */
    private boolean triedSavedLogin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("potfit", MODE_PRIVATE);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        root = new FrameLayout(this);
        web = newWebView(false);
        web.setWebViewClient(new PageClient());
        web.setWebChromeClient(new ChromeClient());
        web.setDownloadListener(this::download);
        root.addView(web);
        setContentView(root);
        fitSystemBars();

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }

        String server = prefs.getString("server", null);
        if (server == null || CHANGE_SERVER.equals(getIntent().getAction())) {
            askServer();
        } else if (state == null || web.restoreState(state) == null) {
            web.loadUrl(server);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (CHANGE_SERVER.equals(intent.getAction())) askServer();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        back();
    }

    /** Back through the page's history; at its start, leave the app running (and the page loaded). */
    private void back() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    /** Android 15 draws apps under the system bars and keyboard; keep the page clear of them. */
    private void fitSystemBars() {
        if (Build.VERSION.SDK_INT < 35) return; // adjustResize and the theme's bar colours do it
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    private WebView newWebView(boolean zoomable) {
        WebView view = new WebView(this);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(true);
        s.setSupportZoom(zoomable);
        s.setBuiltInZoomControls(zoomable);
        s.setDisplayZoomControls(false);
        if (zoomable) {
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
        }
        return view;
    }

    // ------------------------------------------------------------ the server

    private void askServer() {
        String current = prefs.getString("server", null);
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("https://potfit.example.com");
        field.setSingleLine();
        if (current != null) field.setText(current);
        AlertDialog.Builder dialog = new AlertDialog.Builder(this)
                .setTitle("potfit server")
                .setMessage("The address of your potfit server, as you'd open it in a browser.")
                .setView(padded(field))
                .setCancelable(false)
                .setPositiveButton("Open", (d, w) -> {
                    String url = normalise(field.getText().toString());
                    if (url == null) {
                        Toast.makeText(this, "That isn't a web address", Toast.LENGTH_SHORT).show();
                        askServer();
                        return;
                    }
                    prefs.edit().putString("server", url).apply();
                    web.clearHistory();
                    web.loadUrl(url);
                });
        if (current != null) dialog.setNegativeButton("Cancel", null);
        else dialog.setNegativeButton("Quit", (d, w) -> finish());
        dialog.show();
    }

    /** "potfit.lan:5174" -> "https://potfit.lan:5174/"; null if it isn't an http(s) address. */
    static String normalise(String text) {
        String t = text.trim();
        if (t.isEmpty()) return null;
        if (!t.contains("://")) t = "https://" + t;
        Uri uri = Uri.parse(t);
        String scheme = uri.getScheme();
        if (uri.getHost() == null || uri.getHost().isEmpty() || !("http".equals(scheme) || "https".equals(scheme))) return null;
        if (uri.getPath() == null || uri.getPath().isEmpty()) t += "/";
        return t;
    }

    /** Whether a URL is on the potfit server (same scheme, host and port). */
    private boolean onServer(Uri url) {
        Uri server = Uri.parse(prefs.getString("server", ""));
        return Objects.equals(url.getScheme(), server.getScheme())
                && Objects.equals(url.getHost(), server.getHost())
                && port(url) == port(server);
    }

    private static int port(Uri uri) {
        if (uri.getPort() != -1) return uri.getPort();
        return "https".equals(uri.getScheme()) ? 443 : 80;
    }

    private void openExternally(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No app can open " + url, Toast.LENGTH_SHORT).show();
        }
    }

    private class PageClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Links you tap that leave potfit open in the browser. Redirects stay here, so a
            // login page in front of the server (on another host) still works.
            if (onServer(request.getUrl()) || request.isRedirect() || !request.hasGesture()) return false;
            openExternally(request.getUrl());
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            triedSavedLogin = false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Can't reach potfit")
                    .setMessage(request.getUrl() + "\n\n" + error.getDescription())
                    .setPositiveButton("Retry", (d, w) -> view.reload())
                    .setNegativeButton("Change server", (d, w) -> askServer())
                    .show();
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            String[] saved = savedLogin(host);
            if (saved != null && !triedSavedLogin) {
                triedSavedLogin = true;
                handler.proceed(saved[0], saved[1]);
                return;
            }
            askLogin(handler, host, realm, saved);
        }
    }

    // ------------------------------------------------------------ logins (a proxy's basic auth)

    private String[] savedLogin(String host) {
        String user = prefs.getString("login.user." + host, null);
        String password = prefs.getString("login.password." + host, null);
        return user == null || password == null ? null : new String[] {user, password};
    }

    private void askLogin(HttpAuthHandler handler, String host, String realm, String[] saved) {
        EditText user = new EditText(this);
        user.setHint("User name");
        user.setSingleLine();
        EditText password = new EditText(this);
        password.setHint("Password");
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setTypeface(Typeface.DEFAULT); // the password type switches to monospace
        if (saved != null) user.setText(saved[0]);
        LinearLayout fields = new LinearLayout(this);
        fields.setOrientation(LinearLayout.VERTICAL);
        fields.addView(user);
        fields.addView(password);
        new AlertDialog.Builder(this)
                .setTitle("Log in to " + host)
                .setMessage(realm == null || realm.isEmpty() ? null : realm)
                .setView(padded(fields))
                .setCancelable(false)
                .setPositiveButton("Log in", (d, w) -> {
                    String u = user.getText().toString(), p = password.getText().toString();
                    prefs.edit().putString("login.user." + host, u).putString("login.password." + host, p).apply();
                    triedSavedLogin = true;
                    handler.proceed(u, p);
                })
                .setNegativeButton("Cancel", (d, w) -> handler.cancel())
                .show();
    }

    // ------------------------------------------------------------ files, downloads, pictures

    private class ChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pickedFiles != null) pickedFiles.onReceiveValue(null);
            pickedFiles = callback;
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, PICK_FILES);
            } catch (ActivityNotFoundException e) {
                pickedFiles = null;
                return false;
            }
            return true;
        }

        /** A link that opens a new window (a render's full size, say) shows over the app. */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            WebView popup = newWebView(true);
            popup.setBackgroundColor(getColor(R.color.surface));
            Dialog dialog = new Dialog(MainActivity.this, android.R.style.Theme_DeviceDefault_NoActionBar);
            dialog.setContentView(popup);
            dialog.setOnDismissListener(d -> popup.destroy());
            popup.setDownloadListener(MainActivity.this::download);
            popup.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    if (onServer(request.getUrl()) || request.isRedirect()) return false;
                    openExternally(request.getUrl());
                    dialog.dismiss();
                    return true;
                }

                @Override
                public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                    if (!dialog.isShowing() && !isFinishing()) dialog.show();
                }
            });
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILES || pickedFiles == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                result = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] {data.getData()};
            }
        }
        pickedFiles.onReceiveValue(result);
        pickedFiles = null;
    }

    /** Exported STLs and design scripts go to Downloads, with the page's login and cookies. */
    private void download(String url, String userAgent, String contentDisposition, String mimeType, long length) {
        Uri uri = Uri.parse(url);
        if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme())) {
            Toast.makeText(this, "Can't download this file", Toast.LENGTH_SHORT).show();
            return;
        }
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request request = new DownloadManager.Request(uri)
                .setMimeType(mimeType)
                .addRequestHeader("User-Agent", userAgent)
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        String cookies = CookieManager.getInstance().getCookie(url);
        if (cookies != null) request.addRequestHeader("Cookie", cookies);
        String[] login = savedLogin(uri.getHost());
        if (login != null) {
            byte[] pair = (login[0] + ":" + login[1]).getBytes(StandardCharsets.UTF_8);
            request.addRequestHeader("Authorization", "Basic " + Base64.encodeToString(pair, Base64.NO_WRAP));
        }
        getSystemService(DownloadManager.class).enqueue(request);
        Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
    }

    private View padded(View content) {
        FrameLayout frame = new FrameLayout(this);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        frame.setPadding(pad, 0, pad, 0);
        frame.addView(content);
        return frame;
    }
}
