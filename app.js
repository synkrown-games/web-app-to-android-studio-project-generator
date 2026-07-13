// Builds an Android Studio project (as a zip) that wraps a web app in a WebView.
// Pure logic, no DOM. Dependencies (JSZip + wrapper blobs) are injected so this
// runs both in Node tests and in the browser tool.

(function (root) {
    const JAVA_KEYWORDS = new Set([
        'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
        'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
        'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
        'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package',
        'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
        'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
        'try', 'void', 'volatile', 'while', 'true', 'false', 'null'
    ]);

    const JUNK = ['__MACOSX/', '/.DS_Store', '.DS_Store', 'Thumbs.db', '/desktop.ini'];

    const ADMOB_APP_ID_RE = /^ca-app-pub-\d{16}~\d{9,12}$/;
    const ADMOB_AD_UNIT_ID_RE = /^ca-app-pub-\d{16}\/\d{9,12}$/;
    const TEST_ADMOB_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
    const TEST_ADMOB_BANNER_UNIT_ID = 'ca-app-pub-3940256099942544/6300978111';

    function validateAdmobAppId(id) {
        if (!id) return 'AdMob App ID is required.';
        if (!ADMOB_APP_ID_RE.test(id)) return 'Should look like ca-app-pub-XXXXXXXXXXXXXXXX~XXXXXXXXXX.';
        return null;
    }

    function validateAdmobAdUnitId(id) {
        if (!id) return 'Banner ad unit ID is required.';
        if (!ADMOB_AD_UNIT_ID_RE.test(id)) return 'Should look like ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX.';
        return null;
    }

    function validatePackage(pkg) {
        if (!pkg) return 'Package name is required.';
        const parts = pkg.split('.');
        if (parts.length < 2) return 'Package name needs at least two segments, like com.example.app.';
        for (const part of parts) {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part)) {
                return 'Segment "' + part + '" is not a valid identifier.';
            }
            if (JAVA_KEYWORDS.has(part)) {
                return 'Segment "' + part + '" is a reserved Java keyword.';
            }
        }
        return null;
    }

    function xmlEscape(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function isJunk(path) {
        if (path.endsWith('/')) return true;
        return JUNK.some(function (marker) {
            return path === marker || path.indexOf(marker) !== -1;
        });
    }

    // Picks the shallowest index.html and returns its directory as the web root.
    function findWebRoot(paths) {
        let best = null;
        let bestDepth = Infinity;
        for (const p of paths) {
            const lower = p.toLowerCase();
            if (lower === 'index.html' || lower.endsWith('/index.html')) {
                const depth = p.split('/').length;
                if (depth < bestDepth) {
                    bestDepth = depth;
                    best = p;
                }
            }
        }
        if (best === null) return null;
        const slash = best.lastIndexOf('/');
        return slash === -1 ? '' : best.slice(0, slash + 1);
    }

    function base64ToUint8Array(base64) {
        const binary = typeof atob === 'function'
            ? atob(base64)
            : Buffer.from(base64, 'base64').toString('binary');
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function javaStringLiteral(source) {
        return source
            .replace(/\r/g, '')
            .split('\n')
            .map(function (line) {
                const escaped = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                return '            "' + escaped + '\\n"';
            })
            .join(' +\n');
    }

    const DOWNLOAD_BRIDGE_JS = [
        "(function(){",
        "  if (window.__androidSaverReady) { return; }",
        "  window.__androidSaverReady = true;",
        "  function send(blob, filename){",
        "    var reader = new FileReader();",
        "    reader.onloadend = function(){",
        "      var result = reader.result || '';",
        "      var comma = result.indexOf(',');",
        "      var data = comma >= 0 ? result.substring(comma + 1) : '';",
        "      var mime = (blob && blob.type) ? blob.type : 'application/octet-stream';",
        "      AndroidFileSaver.saveBase64(data, filename || 'download', mime);",
        "    };",
        "    reader.readAsDataURL(blob);",
        "  }",
        "  function fromUrl(url, filename){",
        "    fetch(url).then(function(r){ return r.blob(); }).then(function(b){",
        "      send(b, filename);",
        "    }).catch(function(){});",
        "  }",
        "  function nameFor(el){",
        "    var n = el.getAttribute('download');",
        "    if (n) { return n; }",
        "    try {",
        "      var tail = (el.href || '').split('/').pop().split('?')[0];",
        "      return decodeURIComponent(tail) || 'download';",
        "    } catch (e) { return 'download'; }",
        "  }",
        "  function isLocal(href){",
        "    return href && (href.indexOf('blob:') === 0 || href.indexOf('data:') === 0);",
        "  }",
        "  var nativeClick = HTMLAnchorElement.prototype.click;",
        "  HTMLAnchorElement.prototype.click = function(){",
        "    if (this.hasAttribute('download') || isLocal(this.href)) {",
        "      fromUrl(this.href, nameFor(this));",
        "      return;",
        "    }",
        "    return nativeClick.apply(this, arguments);",
        "  };",
        "  document.addEventListener('click', function(e){",
        "    var el = e.target && e.target.closest",
        "      ? e.target.closest('a[download], a[href^=\"blob:\"], a[href^=\"data:\"]')",
        "      : null;",
        "    if (el) {",
        "      e.preventDefault();",
        "      fromUrl(el.href, nameFor(el));",
        "    }",
        "  }, true);",
        "})();"
    ].join('\n');

    function mainActivity(pkg, opts) {
        opts = opts || {};
        const admob = opts.admob || null;
        const media = !!opts.needsMediaPermissions;

        const lines = [];
        function add(s) { lines.push(s); }

        add('package ' + pkg + ';');
        add('');
        add('import android.annotation.SuppressLint;');
        add('import android.app.Activity;');
        add('import android.content.Intent;');
        add('import android.net.Uri;');
        add('import android.os.Bundle;');
        add('import android.util.Base64;');
        add('import android.view.ViewGroup;');
        add('import android.view.ViewParent;');
        add('import android.webkit.DownloadListener;');
        add('import android.webkit.JavascriptInterface;');
        add('import android.webkit.URLUtil;');
        add('import android.webkit.ValueCallback;');
        add('import android.webkit.WebChromeClient;');
        add('import android.webkit.WebResourceRequest;');
        add('import android.webkit.WebResourceResponse;');
        add('import android.webkit.WebSettings;');
        add('import android.webkit.WebView;');
        add('import android.webkit.WebViewClient;');
        add('import android.widget.Toast;');
        add('');
        add('import androidx.activity.OnBackPressedCallback;');
        add('import androidx.activity.result.ActivityResultLauncher;');
        add('import androidx.activity.result.contract.ActivityResultContracts;');
        add('import androidx.annotation.NonNull;');
        add('import androidx.appcompat.app.AppCompatActivity;');
        add('import androidx.webkit.WebViewAssetLoader;');
        add('');
        add('import java.io.InputStream;');
        add('import java.io.OutputStream;');
        add('import java.net.HttpURLConnection;');
        add('import java.net.URL;');
        add('import java.util.concurrent.ExecutorService;');
        add('import java.util.concurrent.Executors;');

        if (media) {
            add('');
            add('import android.Manifest;');
            add('import android.content.pm.PackageManager;');
            add('import android.webkit.PermissionRequest;');
            add('import androidx.core.content.ContextCompat;');
            add('');
            add('import java.util.ArrayList;');
            add('import java.util.List;');
        }

        if (admob) {
            add('');
            add('import android.util.DisplayMetrics;');
            add('import android.view.Gravity;');
            add('import android.widget.LinearLayout;');
            add('');
            add('import com.google.android.gms.ads.AdRequest;');
            add('import com.google.android.gms.ads.AdSize;');
            add('import com.google.android.gms.ads.AdView;');
            add('import com.google.android.gms.ads.MobileAds;');
            add('import com.google.android.ump.ConsentInformation;');
            add('import com.google.android.ump.ConsentRequestParameters;');
            add('import com.google.android.ump.UserMessagingPlatform;');
        }

        add('');
        add('public class MainActivity extends AppCompatActivity {');
        add('');
        add('    private static final String HOST = "appassets.androidplatform.net";');
        add('    private static final String START_URL =');
        add('            "https://appassets.androidplatform.net/assets/www/index.html";');
        if (admob) {
            add('    private static final String BANNER_AD_UNIT_ID = "' + admob.bannerUnitId + '";');
        }
        add('');
        add('    private WebView webView;');
        add('    private final ExecutorService executor = Executors.newSingleThreadExecutor();');
        add('');
        add('    private ValueCallback<Uri[]> fileChooserCallback;');
        add('    private byte[] pendingBytes;');
        add('    private String pendingUrl;');
        if (media) {
            add('    private PermissionRequest pendingPermissionRequest;');
        }
        if (admob) {
            add('    private AdView adView;');
            add('    private ConsentInformation consentInformation;');
        }
        add('');
        add('    private final ActivityResultLauncher<Intent> openFileLauncher =');
        add('            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(),');
        add('                    result -> {');
        add('                        Uri[] value = null;');
        add('                        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {');
        add('                            Uri data = result.getData().getData();');
        add('                            if (data != null) {');
        add('                                value = new Uri[]{data};');
        add('                            }');
        add('                        }');
        add('                        if (fileChooserCallback != null) {');
        add('                            fileChooserCallback.onReceiveValue(value);');
        add('                            fileChooserCallback = null;');
        add('                        }');
        add('                    });');
        add('');
        add('    private final ActivityResultLauncher<Intent> saveFileLauncher =');
        add('            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(),');
        add('                    result -> {');
        add('                        Uri target = null;');
        add('                        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {');
        add('                            target = result.getData().getData();');
        add('                        }');
        add('                        completeSave(target);');
        add('                    });');

        if (media) {
            add('');
            add('    private final ActivityResultLauncher<String[]> runtimePermissionLauncher =');
            add('            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(),');
            add('                    grantResults -> {');
            add('                        if (pendingPermissionRequest == null) {');
            add('                            return;');
            add('                        }');
            add('                        List<String> granted = new ArrayList<>();');
            add('                        for (String resource : pendingPermissionRequest.getResources()) {');
            add('                            String permission = toAndroidPermission(resource);');
            add('                            if (permission != null && Boolean.TRUE.equals(grantResults.get(permission))) {');
            add('                                granted.add(resource);');
            add('                            }');
            add('                        }');
            add('                        if (granted.isEmpty()) {');
            add('                            pendingPermissionRequest.deny();');
            add('                        } else {');
            add('                            pendingPermissionRequest.grant(granted.toArray(new String[0]));');
            add('                        }');
            add('                        pendingPermissionRequest = null;');
            add('                    });');
        }

        add('');
        add('    @SuppressLint("SetJavaScriptEnabled")');
        add('    @Override');
        add('    protected void onCreate(Bundle savedInstanceState) {');
        add('        super.onCreate(savedInstanceState);');
        add('');
        add('        webView = new WebView(this);');

        if (admob) {
            add('');
            add('        LinearLayout root = new LinearLayout(this);');
            add('        root.setOrientation(LinearLayout.VERTICAL);');
            add('        root.addView(webView, new LinearLayout.LayoutParams(');
            add('                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));');
            add('');
            add('        adView = new AdView(this);');
            add('        adView.setAdUnitId(BANNER_AD_UNIT_ID);');
            add('        LinearLayout.LayoutParams adParams = new LinearLayout.LayoutParams(');
            add('                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);');
            add('        adParams.gravity = Gravity.CENTER_HORIZONTAL;');
            add('        root.addView(adView, adParams);');
            add('');
            add('        setContentView(root);');
        } else {
            add('        setContentView(webView);');
        }

        add('');
        add('        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()');
        add('                .setDomain(HOST)');
        add('                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))');
        add('                .build();');
        add('');
        add('        WebSettings settings = webView.getSettings();');
        add('        settings.setJavaScriptEnabled(true);');
        add('        settings.setDomStorageEnabled(true);');
        add('        settings.setDatabaseEnabled(true);');
        add('        settings.setMediaPlaybackRequiresUserGesture(false);');
        add('        settings.setUseWideViewPort(true);');
        add('        settings.setLoadWithOverviewMode(true);');
        add('');
        add('        webView.setWebViewClient(new WebViewClient() {');
        add('            @Override');
        add('            public WebResourceResponse shouldInterceptRequest(WebView view,');
        add('                                                              WebResourceRequest request) {');
        add('                return assetLoader.shouldInterceptRequest(request.getUrl());');
        add('            }');
        add('');
        add('            @Override');
        add('            public void onPageFinished(WebView view, String url) {');
        add('                view.evaluateJavascript(DOWNLOAD_BRIDGE, null);');
        add('            }');
        add('        });');
        add('');
        add('        webView.setWebChromeClient(new WebChromeClient() {');
        add('            @Override');
        add('            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,');
        add('                                             FileChooserParams params) {');
        add('                fileChooserCallback = callback;');
        add('                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);');
        add('                intent.addCategory(Intent.CATEGORY_OPENABLE);');
        add('                intent.setType("*/*");');
        add('                String[] accept = params.getAcceptTypes();');
        add('                if (accept != null && accept.length > 0 && accept[0] != null && !accept[0].isEmpty()) {');
        add('                    intent.setType(accept[0]);');
        add('                }');
        add('                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {');
        add('                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);');
        add('                }');
        add('                try {');
        add('                    openFileLauncher.launch(intent);');
        add('                } catch (Exception e) {');
        add('                    fileChooserCallback = null;');
        add('                    return false;');
        add('                }');
        add('                return true;');
        add('            }');

        if (media) {
            add('');
            add('            @Override');
            add('            public void onPermissionRequest(PermissionRequest request) {');
            add('                List<String> neededPermissions = new ArrayList<>();');
            add('                for (String resource : request.getResources()) {');
            add('                    String permission = toAndroidPermission(resource);');
            add('                    if (permission != null) {');
            add('                        neededPermissions.add(permission);');
            add('                    }');
            add('                }');
            add('                if (neededPermissions.isEmpty()) {');
            add('                    request.deny();');
            add('                    return;');
            add('                }');
            add('                boolean allGranted = true;');
            add('                for (String permission : neededPermissions) {');
            add('                    if (ContextCompat.checkSelfPermission(MainActivity.this, permission)');
            add('                            != PackageManager.PERMISSION_GRANTED) {');
            add('                        allGranted = false;');
            add('                        break;');
            add('                    }');
            add('                }');
            add('                if (allGranted) {');
            add('                    request.grant(request.getResources());');
            add('                    return;');
            add('                }');
            add('                pendingPermissionRequest = request;');
            add('                runtimePermissionLauncher.launch(neededPermissions.toArray(new String[0]));');
            add('            }');
        }

        add('        });');
        add('');
        add('        webView.setDownloadListener(new DownloadListener() {');
        add('            @Override');
        add('            public void onDownloadStart(String url, String userAgent, String disposition,');
        add('                                        String mimeType, long contentLength) {');
        add('                if (url.startsWith("blob:") || url.startsWith("data:")) {');
        add('                    return;');
        add('                }');
        add('                String name = URLUtil.guessFileName(url, disposition, mimeType);');
        add('                startRemoteSave(url, name, mimeType);');
        add('            }');
        add('        });');
        add('');
        add('        webView.addJavascriptInterface(new SaveBridge(), "AndroidFileSaver");');
        add('');
        add('        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {');
        add('            @Override');
        add('            public void handleOnBackPressed() {');
        add('                if (webView != null && webView.canGoBack()) {');
        add('                    webView.goBack();');
        add('                } else {');
        add('                    setEnabled(false);');
        add('                    getOnBackPressedDispatcher().onBackPressed();');
        add('                }');
        add('            }');
        add('        });');

        if (admob) {
            add('');
            add('        initializeAds();');
        }

        add('');
        add('        if (savedInstanceState == null) {');
        add('            webView.loadUrl(START_URL);');
        add('        }');
        add('    }');
        add('');
        add('    @Override');
        add('    protected void onSaveInstanceState(@NonNull Bundle outState) {');
        add('        super.onSaveInstanceState(outState);');
        add('        if (webView != null) {');
        add('            webView.saveState(outState);');
        add('        }');
        add('    }');
        add('');
        add('    @Override');
        add('    protected void onRestoreInstanceState(@NonNull Bundle savedInstanceState) {');
        add('        super.onRestoreInstanceState(savedInstanceState);');
        add('        if (webView != null) {');
        add('            webView.restoreState(savedInstanceState);');
        add('        }');
        add('    }');
        add('');
        add('    @Override');
        add('    protected void onPause() {');
        add('        if (webView != null) {');
        add('            webView.onPause();');
        add('        }');
        if (admob) {
            add('        if (adView != null) {');
            add('            adView.pause();');
            add('        }');
        }
        add('        super.onPause();');
        add('    }');
        add('');
        add('    @Override');
        add('    protected void onResume() {');
        add('        super.onResume();');
        add('        if (webView != null) {');
        add('            webView.onResume();');
        add('        }');
        if (admob) {
            add('        if (adView != null) {');
            add('            adView.resume();');
            add('        }');
        }
        add('    }');

        if (media) {
            add('');
            add('    private static String toAndroidPermission(String webkitResource) {');
            add('        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(webkitResource)) {');
            add('            return Manifest.permission.CAMERA;');
            add('        }');
            add('        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(webkitResource)) {');
            add('            return Manifest.permission.RECORD_AUDIO;');
            add('        }');
            add('        return null;');
            add('    }');
        }

        if (admob) {
            add('');
            add('    private void initializeAds() {');
            add('        ConsentRequestParameters params = new ConsentRequestParameters.Builder().build();');
            add('        consentInformation = UserMessagingPlatform.getConsentInformation(this);');
            add('        consentInformation.requestConsentInfoUpdate(this, params, () ->');
            add('                UserMessagingPlatform.loadAndShowConsentFormIfRequired(this, formError -> {');
            add('                    if (consentInformation.canRequestAds()) {');
            add('                        startAds();');
            add('                    }');
            add('                }), requestError -> {');
            add('            if (consentInformation.canRequestAds()) {');
            add('                startAds();');
            add('            }');
            add('        });');
            add('        if (consentInformation.canRequestAds()) {');
            add('            startAds();');
            add('        }');
            add('    }');
            add('');
            add('    private void startAds() {');
            add('        MobileAds.initialize(this, status -> loadBannerAd());');
            add('    }');
            add('');
            add('    private void loadBannerAd() {');
            add('        if (adView == null) {');
            add('            return;');
            add('        }');
            add('        adView.setAdSize(getAdSize());');
            add('        adView.loadAd(new AdRequest.Builder().build());');
            add('    }');
            add('');
            add('    private AdSize getAdSize() {');
            add('        DisplayMetrics metrics = getResources().getDisplayMetrics();');
            add('        int adWidth = (int) (metrics.widthPixels / metrics.density);');
            add('        return AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(this, adWidth);');
            add('    }');
        }

        add('');
        add('    private void startSaveBytes(byte[] data, String filename, String mime) {');
        add('        pendingBytes = data;');
        add('        pendingUrl = null;');
        add('        launchSaveDialog(filename, mime);');
        add('    }');
        add('');
        add('    private void startRemoteSave(String url, String filename, String mime) {');
        add('        pendingBytes = null;');
        add('        pendingUrl = url;');
        add('        launchSaveDialog(filename, mime);');
        add('    }');
        add('');
        add('    private void launchSaveDialog(String filename, String mime) {');
        add('        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);');
        add('        intent.addCategory(Intent.CATEGORY_OPENABLE);');
        add('        intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);');
        add('        intent.putExtra(Intent.EXTRA_TITLE,');
        add('                filename == null || filename.isEmpty() ? "download" : filename);');
        add('        try {');
        add('            saveFileLauncher.launch(intent);');
        add('        } catch (Exception e) {');
        add('            pendingBytes = null;');
        add('            pendingUrl = null;');
        add('            toast("No app available to save files");');
        add('        }');
        add('    }');
        add('');
        add('    private void completeSave(Uri target) {');
        add('        final byte[] bytes = pendingBytes;');
        add('        final String url = pendingUrl;');
        add('        pendingBytes = null;');
        add('        pendingUrl = null;');
        add('        if (target == null) {');
        add('            return;');
        add('        }');
        add('        if (bytes != null) {');
        add('            executor.execute(() -> writeBytes(target, bytes));');
        add('        } else if (url != null) {');
        add('            executor.execute(() -> streamToTarget(url, target));');
        add('        }');
        add('    }');
        add('');
        add('    private void writeBytes(Uri target, byte[] data) {');
        add('        try (OutputStream out = getContentResolver().openOutputStream(target)) {');
        add('            if (out != null) {');
        add('                out.write(data);');
        add('                out.flush();');
        add('            }');
        add('            postToast("Saved");');
        add('        } catch (Exception e) {');
        add('            postToast("Could not save file");');
        add('        }');
        add('    }');
        add('');
        add('    private void streamToTarget(String url, Uri target) {');
        add('        HttpURLConnection conn = null;');
        add('        try {');
        add('            conn = (HttpURLConnection) new URL(url).openConnection();');
        add('            conn.setConnectTimeout(15000);');
        add('            conn.setReadTimeout(15000);');
        add('            try (InputStream in = conn.getInputStream();');
        add('                 OutputStream out = getContentResolver().openOutputStream(target)) {');
        add('                if (out != null) {');
        add('                    byte[] buffer = new byte[8192];');
        add('                    int read;');
        add('                    while ((read = in.read(buffer)) != -1) {');
        add('                        out.write(buffer, 0, read);');
        add('                    }');
        add('                    out.flush();');
        add('                }');
        add('            }');
        add('            postToast("Saved");');
        add('        } catch (Exception e) {');
        add('            postToast("Could not save file");');
        add('        } finally {');
        add('            if (conn != null) {');
        add('                conn.disconnect();');
        add('            }');
        add('        }');
        add('    }');
        add('');
        add('    private void postToast(String message) {');
        add('        runOnUiThread(() -> toast(message));');
        add('    }');
        add('');
        add('    private void toast(String message) {');
        add('        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();');
        add('    }');
        add('');
        add('    @Override');
        add('    protected void onDestroy() {');
        add('        executor.shutdownNow();');
        if (admob) {
            add('        if (adView != null) {');
            add('            adView.destroy();');
            add('            adView = null;');
            add('        }');
        }
        add('        if (webView != null) {');
        add('            webView.stopLoading();');
        add('            webView.setWebChromeClient(null);');
        add('            webView.setWebViewClient(new WebViewClient());');
        add('            webView.removeJavascriptInterface("AndroidFileSaver");');
        add('            webView.loadUrl("about:blank");');
        add('            ViewParent parent = webView.getParent();');
        add('            if (parent instanceof ViewGroup) {');
        add('                ((ViewGroup) parent).removeView(webView);');
        add('            }');
        add('            webView.destroy();');
        add('            webView = null;');
        add('        }');
        add('        super.onDestroy();');
        add('    }');
        add('');
        add('    private class SaveBridge {');
        add('        @JavascriptInterface');
        add('        public void saveBase64(String base64, String filename, String mime) {');
        add('            if (base64 == null) {');
        add('                return;');
        add('            }');
        add('            final byte[] data;');
        add('            try {');
        add('                data = Base64.decode(base64, Base64.DEFAULT);');
        add('            } catch (IllegalArgumentException e) {');
        add('                return;');
        add('            }');
        add('            runOnUiThread(() -> startSaveBytes(data, filename, mime));');
        add('        }');
        add('    }');
        add('');
        add('    private static final String DOWNLOAD_BRIDGE =');

        return lines.join('\n') + '\n' + javaStringLiteral(DOWNLOAD_BRIDGE_JS) + ';\n}\n';
    }

    function buildFiles(opts) {
        const pkg = opts.packageName;
        const pkgPath = pkg.replace(/\./g, '/');
        const appLabel = xmlEscape(opts.appName);

        let admob = null;
        if (opts.admob && opts.admob.enabled) {
            admob = {
                appId: opts.admob.useTestAds ? TEST_ADMOB_APP_ID : opts.admob.appId,
                bannerUnitId: opts.admob.useTestAds ? TEST_ADMOB_BANNER_UNIT_ID : opts.admob.bannerUnitId
            };
        }

        const permSet = new Set();
        if (opts.includeInternet || admob) permSet.add('android.permission.INTERNET');
        (opts.permissions || []).forEach(function (p) { if (p) permSet.add(p); });
        const permissions = permSet.size
            ? Array.from(permSet).map(function (p) {
                return '    <uses-permission android:name="' + p + '" />';
            }).join('\n') + '\n\n'
            : '';
        const cleartext = opts.allowCleartext ? 'true' : 'false';
        const needsMediaPermissions = permSet.has('android.permission.CAMERA') ||
            permSet.has('android.permission.RECORD_AUDIO');

        const files = {};

        files['settings.gradle'] =
            'pluginManagement {\n' +
            '    repositories {\n' +
            '        google()\n' +
            '        mavenCentral()\n' +
            '        gradlePluginPortal()\n' +
            '    }\n' +
            '}\n' +
            'dependencyResolutionManagement {\n' +
            '    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)\n' +
            '    repositories {\n' +
            '        google()\n' +
            '        mavenCentral()\n' +
            '    }\n' +
            '}\n' +
            'rootProject.name = "' + opts.appName.replace(/"/g, '') + '"\n' +
            'include ":app"\n';

        files['build.gradle'] =
            'plugins {\n' +
            "    id 'com.android.application' version '9.2.0' apply false\n" +
            '}\n';

        files['gradle.properties'] =
            'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\n' +
            'org.gradle.caching=true\n' +
            'android.useAndroidX=true\n' +
            'android.nonTransitiveRClass=true\n';

        files['gradle/wrapper/gradle-wrapper.properties'] =
            'distributionBase=GRADLE_USER_HOME\n' +
            'distributionPath=wrapper/dists\n' +
            'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.1-bin.zip\n' +
            'networkTimeout=10000\n' +
            'validateDistributionUrl=true\n' +
            'zipStoreBase=GRADLE_USER_HOME\n' +
            'zipStorePath=wrapper/dists\n';

        files['.gitignore'] =
            '.gradle/\n' +
            'build/\n' +
            'local.properties\n' +
            '.idea/\n' +
            '*.iml\n' +
            '.DS_Store\n';

        files['app/.gitignore'] = '/build\n';

        files['app/proguard-rules.pro'] =
            '-keepclassmembers class * {\n' +
            '    @android.webkit.JavascriptInterface <methods>;\n' +
            '}\n';

        const admobDeps = admob
            ? "    implementation 'com.google.android.gms:play-services-ads:25.4.0'\n" +
            "    implementation 'com.google.android.ump:user-messaging-platform:4.0.0'\n"
            : '';

        files['app/build.gradle'] =
            'plugins {\n' +
            "    id 'com.android.application'\n" +
            '}\n' +
            '\n' +
            'android {\n' +
            '    namespace "' + pkg + '"\n' +
            '    compileSdk 36\n' +
            '\n' +
            '    defaultConfig {\n' +
            '        applicationId "' + pkg + '"\n' +
            '        minSdk ' + opts.minSdk + '\n' +
            '        targetSdk 36\n' +
            '        versionCode 1\n' +
            '        versionName "1.0"\n' +
            '    }\n' +
            '\n' +
            '    buildTypes {\n' +
            '        release {\n' +
            '            minifyEnabled false\n' +
            "            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'\n" +
            '        }\n' +
            '    }\n' +
            '\n' +
            '    compileOptions {\n' +
            '        sourceCompatibility JavaVersion.VERSION_17\n' +
            '        targetCompatibility JavaVersion.VERSION_17\n' +
            '    }\n' +
            '}\n' +
            '\n' +
            'dependencies {\n' +
            "    implementation 'androidx.appcompat:appcompat:1.7.1'\n" +
            "    implementation 'androidx.webkit:webkit:1.16.0'\n" +
            admobDeps +
            '}\n' +
            '\n' +
            'configurations.all {\n' +
            "    exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk7'\n" +
            "    exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk8'\n" +
            '}\n';

        const admobMeta = admob
            ? '        <meta-data\n' +
            '            android:name="com.google.android.gms.ads.APPLICATION_ID"\n' +
            '            android:value="' + admob.appId + '" />\n' +
            '\n'
            : '';

        files['app/src/main/AndroidManifest.xml'] =
            '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' +
            '\n' +
            permissions +
            '    <application\n' +
            '        android:allowBackup="true"\n' +
            '        android:icon="@mipmap/ic_launcher"\n' +
            '        android:label="@string/app_name"\n' +
            '        android:roundIcon="@mipmap/ic_launcher_round"\n' +
            '        android:supportsRtl="true"\n' +
            '        android:theme="@style/Theme.WebAppWrapper"\n' +
            '        android:usesCleartextTraffic="' + cleartext + '">\n' +
            admobMeta +
            '        <activity\n' +
            '            android:name=".MainActivity"\n' +
            '            android:exported="true"\n' +
            '            android:configChanges="orientation|screenSize|keyboardHidden|smallestScreenSize|screenLayout">\n' +
            '            <intent-filter>\n' +
            '                <action android:name="android.intent.action.MAIN" />\n' +
            '                <category android:name="android.intent.category.LAUNCHER" />\n' +
            '            </intent-filter>\n' +
            '        </activity>\n' +
            '    </application>\n' +
            '</manifest>\n';

        files['app/src/main/java/' + pkgPath + '/MainActivity.java'] = mainActivity(pkg, {
            admob: admob,
            needsMediaPermissions: needsMediaPermissions
        });

        files['app/src/main/res/values/strings.xml'] =
            '<resources>\n' +
            '    <string name="app_name">' + appLabel + '</string>\n' +
            '</resources>\n';

        files['app/src/main/res/values/colors.xml'] =
            '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<resources>\n' +
            '    <color name="ic_launcher_background">#1F6FEB</color>\n' +
            '    <color name="status_bar">#1B60CC</color>\n' +
            '</resources>\n';

        files['app/src/main/res/values/themes.xml'] =
            '<resources>\n' +
            '    <style name="Theme.WebAppWrapper" parent="Theme.AppCompat.Light.NoActionBar">\n' +
            '        <item name="android:statusBarColor">@color/status_bar</item>\n' +
            '        <item name="android:windowBackground">@android:color/white</item>\n' +
            '    </style>\n' +
            '</resources>\n';

        if (opts.iconPngs) {
            ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].forEach(function (density) {
                const png = opts.iconPngs[density];
                if (!png) return;
                files['app/src/main/res/mipmap-' + density + '/ic_launcher.png'] = png;
                files['app/src/main/res/mipmap-' + density + '/ic_launcher_round.png'] = png;
            });
        } else {
            const adaptiveIcon =
                '<?xml version="1.0" encoding="utf-8"?>\n' +
                '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
                '    <background android:drawable="@drawable/ic_launcher_background" />\n' +
                '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n' +
                '</adaptive-icon>\n';
            files['app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml'] = adaptiveIcon;
            files['app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml'] = adaptiveIcon;
            files['app/src/main/res/drawable/ic_launcher_background.xml'] =
                '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n' +
                '    android:width="108dp" android:height="108dp"\n' +
                '    android:viewportWidth="108" android:viewportHeight="108">\n' +
                '    <path android:fillColor="@color/ic_launcher_background"\n' +
                '        android:pathData="M0,0h108v108h-108z" />\n' +
                '</vector>\n';
            files['app/src/main/res/drawable/ic_launcher_foreground.xml'] =
                '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n' +
                '    android:width="108dp" android:height="108dp"\n' +
                '    android:viewportWidth="108" android:viewportHeight="108">\n' +
                '    <group>\n' +
                '        <path android:strokeColor="#FFFFFF" android:strokeWidth="3.5"\n' +
                '            android:fillColor="#00000000"\n' +
                '            android:pathData="M54,30 a24,24 0 1,0 0.01,0 Z" />\n' +
                '        <path android:strokeColor="#FFFFFF" android:strokeWidth="3.5"\n' +
                '            android:fillColor="#00000000"\n' +
                '            android:pathData="M30,54 L78,54" />\n' +
                '        <path android:strokeColor="#FFFFFF" android:strokeWidth="3.5"\n' +
                '            android:fillColor="#00000000"\n' +
                '            android:pathData="M54,30 C40,42 40,66 54,78 C68,66 68,42 54,30 Z" />\n' +
                '    </group>\n' +
                '</vector>\n';
        }

        return files;
    }

    // Main entry. deps: { JSZip, wrapperJarB64, gradlewB64, gradlewBatB64 }
    async function generateProject(opts, deps) {
        const pkgError = validatePackage(opts.packageName);
        if (pkgError) throw new Error(pkgError);
        if (!opts.appName || !opts.appName.trim()) throw new Error('App name is required.');

        if (opts.admob && opts.admob.enabled && !opts.admob.useTestAds) {
            const appIdError = validateAdmobAppId(opts.admob.appId);
            if (appIdError) throw new Error(appIdError);
            const unitIdError = validateAdmobAdUnitId(opts.admob.bannerUnitId);
            if (unitIdError) throw new Error(unitIdError);
        }

        const JSZip = deps.JSZip;
        const source = await JSZip.loadAsync(opts.zipData);

        const entries = [];
        source.forEach(function (relPath, entry) {
            if (!entry.dir && !isJunk(relPath)) entries.push(relPath);
        });
        if (entries.length === 0) throw new Error('The uploaded zip has no files.');

        const webRoot = findWebRoot(entries);
        if (webRoot === null) {
            throw new Error('No index.html found in the zip. The web app needs an index.html entry point.');
        }

        const out = new JSZip();
        const textFiles = buildFiles(opts);
        for (const path in textFiles) {
            out.file(path, textFiles[path]);
        }

        out.file('gradle/wrapper/gradle-wrapper.jar', base64ToUint8Array(deps.wrapperJarB64));
        out.file('gradlew', base64ToUint8Array(deps.gradlewB64), { unixPermissions: 0x1ED });
        out.file('gradlew.bat', base64ToUint8Array(deps.gradlewBatB64));

        const assetBase = 'app/src/main/assets/www/';
        let copied = 0;
        for (const relPath of entries) {
            if (webRoot && relPath.indexOf(webRoot) !== 0) continue;
            const inner = webRoot ? relPath.slice(webRoot.length) : relPath;
            if (!inner) continue;
            const content = await source.file(relPath).async('uint8array');
            out.file(assetBase + inner, content);
            copied++;
        }
        if (copied === 0) throw new Error('No web app files were copied. Check the zip contents.');

        const entries2 = [];
        out.forEach(function (relPath, entry) {
            if (!entry.dir) entries2.push(relPath);
        });
        entries2.sort();

        const payload = await out.generateAsync({
            type: opts.outputType || 'blob',
            platform: 'UNIX',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        return { payload: payload, fileCount: copied, webRoot: webRoot, entries: entries2 };
    }

    const api = {
        generateProject: generateProject,
        validatePackage: validatePackage,
        validateAdmobAppId: validateAdmobAppId,
        validateAdmobAdUnitId: validateAdmobAdUnitId,
        findWebRoot: findWebRoot,
        buildFiles: buildFiles,
        isJunk: isJunk
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.AndroidWrapper = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

var WRAPPER_JAR_B64 = "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UGFyc2VyJEFmdGVyT3B0aW9ucy5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQCL4zEXLAMAAF0HAAA8AAkAAAAAAAAAAAAAANMVAABvcmcvZ3JhZGxlL2NsaS9Db21tYW5kTGluZVBhcnNlciRCZWZvcmVGaXJzdFN1YkNvbW1hbmQuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEA6doPs98GAABiDgAAPQAJAAAAAAAAAAAAAAByGQAAb3JnL2dyYWRsZS9jbGkvQ29tbWFuZExpbmVQYXJzZXIkS25vd25PcHRpb25QYXJzZXJTdGF0ZS5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQBDJ3yiTAIAAJcEAAA8AAkAAAAAAAAAAAAAAMUgAABvcmcvZ3JhZGxlL2NsaS9Db21tYW5kTGluZVBhcnNlciRNaXNzaW5nT3B0aW9uQXJnU3RhdGUuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEAtJRbo9cCAABKBQAAPQAJAAAAAAAAAAAAAACEIwAAb3JnL2dyYWRsZS9jbGkvQ29tbWFuZExpbmVQYXJzZXIkT3B0aW9uQXdhcmVQYXJzZXJTdGF0ZS5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQB1W3o/ogEAAH0CAAA4AAkAAAAAAAAAAAAAAM8mAABvcmcvZ3JhZGxlL2NsaS9Db21tYW5kTGluZVBhcnNlciRPcHRpb25QYXJzZXJTdGF0ZS5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQAW1+kcDQIAAEMDAAAzAAkAAAAAAAAAAAAAAOAoAABvcmcvZ3JhZGxlL2NsaS9Db21tYW5kTGluZVBhcnNlciRPcHRpb25TdHJpbmcuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEAkMnJiacBAADOAgAAMgAJAAAAAAAAAAAAAABXKwAAb3JnL2dyYWRsZS9jbGkvQ29tbWFuZExpbmVQYXJzZXIkUGFyc2VyU3RhdGUuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEAS8+WoHMCAADHBAAAPwAJAAAAAAAAAAAAAABnLQAAb3JnL2dyYWRsZS9jbGkvQ29tbWFuZExpbmVQYXJzZXIkVW5rbm93bk9wdGlvblBhcnNlclN0YXRlLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAB2MmemvBAAAYwgAACYACQAAAAAAAAAAAAAAUDAAAG9yZy9ncmFkbGUvY2xpL0NvbW1hbmRMaW5lUGFyc2VyLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAOsyd406BAAA4QcAACYACQAAAAAAAAAAAAAAXDUAAG9yZy9ncmFkbGUvY2xpL1BhcnNlZENvbW1hbmRMaW5lLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAFrddm1UAQAArAEAACwACQAAAAAAAAAAAAAA8zkAAG9yZy9ncmFkbGUvY2xpL1BhcnNlZENvbW1hbmRMaW5lT3B0aW9uLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAPkkTxT/AgAAnAQAADMACQAAAAAAAAAAAAAAqjsAAG9yZy9ncmFkbGUvaW50ZXJuYWwvZmlsZS9QYXRoVHJhdmVyc2FsQ2hlY2tlci5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQB5tXfKhwEAAAMCAABBAAkAAAAAAAAAAAAAABM/AABvcmcvZ3JhZGxlL2ludGVybmFsL2ZpbGUvbG9ja2luZy9FeGNsdXNpdmVGaWxlQWNjZXNzTWFuYWdlci5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQBipwaKwQEAAKMCAAA+AAkAAAAAAAAAAAAAABJBAABvcmcvZ3JhZGxlL3V0aWwvaW50ZXJuYWwvV3JhcHBlckRpc3RyaWJ1dGlvblVybENvbnZlcnRlci5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQCcRdKajgEAAB4CAAAvAAkAAAAAAAAAAAAAAEhDAABvcmcvZ3JhZGxlL3dyYXBwZXIvQm9vdHN0cmFwTWFpblN0YXJ0ZXIkMS5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQCA0yUGKQMAAOQEAABBAAkAAAAAAAAAAAAAADxFAABvcmcvZ3JhZGxlL3dyYXBwZXIvRG93bmxvYWQkRGVmYXVsdERvd25sb2FkUHJvZ3Jlc3NMaXN0ZW5lci5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQB3o7Ym5QIAABEFAAA0AAkAAAAAAAAAAAAAAN1IAABvcmcvZ3JhZGxlL3dyYXBwZXIvRG93bmxvYWQkUHJveHlBdXRoZW50aWNhdG9yLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhABgEsAxlCQAAKhIAACEACQAAAAAAAAAAAAAALUwAAG9yZy9ncmFkbGUvd3JhcHBlci9Eb3dubG9hZC5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQBBcxcJ2QEAALICAAAtAAkAAAAAAAAAAAAAAOpVAABvcmcvZ3JhZGxlL3dyYXBwZXIvR3JhZGxlVXNlckhvbWVMb29rdXAuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEA3RS7hw0VAACpKQAAKgAJAAAAAAAAAAAAAAAnWAAAb3JnL2dyYWRsZS93cmFwcGVyL0dyYWRsZVdyYXBwZXJNYWluLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhACKYkR7DCwAAuhUAACIACQAAAAAAAAAAAAAAlW0AAG9yZy9ncmFkbGUvd3JhcHBlci9JbnN0YWxsJDEuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEAqgSTSmoBAADnAQAALQAJAAAAAAAAAAAAAACxeQAAb3JnL2dyYWRsZS93cmFwcGVyL0luc3RhbGwkSW5zdGFsbENoZWNrLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAD8+qWeoDgAA2hsAACAACQAAAAAAAAAAAAAAf3sAAG9yZy9ncmFkbGUvd3JhcHBlci9JbnN0YWxsLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAF32tW87AgAAHgQAAB8ACQAAAAAAAAAAAAAAfooAAG9yZy9ncmFkbGUvd3JhcHBlci9Mb2dnZXIuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEA6imTPiQBAABqAQAAJgAJAAAAAAAAAAAAAAAPjQAAb3JnL2dyYWRsZS93cmFwcGVyL1BhdGhBc3NlbWJsZXIuY2xhc3NVVAUAAQAAAABQSwECFAAUAAgICAAAACEA1uMlrJoDAABOBgAAMAAJAAAAAAAAAAAAAACQjgAAb3JnL2dyYWRsZS93cmFwcGVyL1N5c3RlbVByb3BlcnRpZXNIYW5kbGVyLmNsYXNzVVQFAAEAAAAAUEsBAhQAFAAICAgAAAAhAOYRBMnuAgAAUAYAAC0ACQAAAAAAAAAAAAAAkZIAAG9yZy9ncmFkbGUvd3JhcHBlci9XcmFwcGVyQ29uZmlndXJhdGlvbi5jbGFzc1VUBQABAAAAAFBLAQIUABQACAgIAAAAIQARWWHoUwYAAMUMAAAoAAkAAAAAAAAAAAAAAOOVAABvcmcvZ3JhZGxlL3dyYXBwZXIvV3JhcHBlckV4ZWN1dG9yLmNsYXNzVVQFAAEAAAAAUEsFBgAAAAAhACEAEg0AAJWcAAAAAA==";
var GRADLEW_B64 = "IyEvYmluL3NoCgojCiMgQ29weXJpZ2h0IMKpIDIwMTUtMjAyMSB0aGUgb3JpZ2luYWwgYXV0aG9ycy4KIwojIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSAiTGljZW5zZSIpOwojIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS4KIyBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXQKIwojICAgICAgaHR0cHM6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMAojCiMgVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZQojIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuICJBUyBJUyIgQkFTSVMsCiMgV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuCiMgU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZAojIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLgojCgojIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMKIwojICAgR3JhZGxlIHN0YXJ0IHVwIHNjcmlwdCBmb3IgUE9TSVggZ2VuZXJhdGVkIGJ5IEdyYWRsZS4KIwojICAgSW1wb3J0YW50IGZvciBydW5uaW5nOgojCiMgICAoMSkgWW91IG5lZWQgYSBQT1NJWC1jb21wbGlhbnQgc2hlbGwgdG8gcnVuIHRoaXMgc2NyaXB0LiBJZiB5b3VyIC9iaW4vc2ggaXMKIyAgICAgICBub25jb21wbGlhbnQsIGJ1dCB5b3UgaGF2ZSBzb21lIG90aGVyIGNvbXBsaWFudCBzaGVsbCBzdWNoIGFzIGtzaCBvcgojICAgICAgIGJhc2gsIHRoZW4gdG8gcnVuIHRoaXMgc2NyaXB0LCB0eXBlIHRoYXQgc2hlbGwgbmFtZSBiZWZvcmUgdGhlIHdob2xlCiMgICAgICAgY29tbWFuZCBsaW5lLCBsaWtlOgojCiMgICAgICAgICAgIGtzaCBHcmFkbGUKIwojICAgICAgIEJ1c3lib3ggYW5kIHNpbWlsYXIgcmVkdWNlZCBzaGVsbHMgd2lsbCBOT1Qgd29yaywgYmVjYXVzZSB0aGlzIHNjcmlwdAojICAgICAgIHJlcXVpcmVzIGFsbCBvZiB0aGVzZSBQT1NJWCBzaGVsbCBmZWF0dXJlczoKIyAgICAgICAgICogZnVuY3Rpb25zOwojICAgICAgICAgKiBleHBhbnNpb25zIMKrJHZhcsK7LCDCqyR7dmFyfcK7LCDCqyR7dmFyOi1kZWZhdWx0fcK7LCDCqyR7dmFyK1NFVH3CuywKIyAgICAgICAgICAgwqske3ZhciNwcmVmaXh9wrssIMKrJHt2YXIlc3VmZml4fcK7LCBhbmQgwqskKCBjbWQgKcK7OwojICAgICAgICAgKiBjb21wb3VuZCBjb21tYW5kcyBoYXZpbmcgYSB0ZXN0YWJsZSBleGl0IHN0YXR1cywgZXNwZWNpYWxseSDCq2Nhc2XCuzsKIyAgICAgICAgICogdmFyaW91cyBidWlsdC1pbiBjb21tYW5kcyBpbmNsdWRpbmcgwqtjb21tYW5kwrssIMKrc2V0wrssIGFuZCDCq3VsaW1pdMK7LgojCiMgICBJbXBvcnRhbnQgZm9yIHBhdGNoaW5nOgojCiMgICAoMikgVGhpcyBzY3JpcHQgdGFyZ2V0cyBhbnkgUE9TSVggc2hlbGwsIHNvIGl0IGF2b2lkcyBleHRlbnNpb25zIHByb3ZpZGVkCiMgICAgICAgYnkgQmFzaCwgS3NoLCBldGM7IGluIHBhcnRpY3VsYXIgYXJyYXlzIGFyZSBhdm9pZGVkLgojCiMgICAgICAgVGhlICJ0cmFkaXRpb25hbCIgcHJhY3RpY2Ugb2YgcGFja2luZyBtdWx0aXBsZSBwYXJhbWV0ZXJzIGludG8gYQojICAgICAgIHNwYWNlLXNlcGFyYXRlZCBzdHJpbmcgaXMgYSB3ZWxsIGRvY3VtZW50ZWQgc291cmNlIG9mIGJ1Z3MgYW5kIHNlY3VyaXR5CiMgICAgICAgcHJvYmxlbXMsIHNvIHRoaXMgaXMgKG1vc3RseSkgYXZvaWRlZCwgYnkgcHJvZ3Jlc3NpdmVseSBhY2N1bXVsYXRpbmcKIyAgICAgICBvcHRpb25zIGluICIkQCIsIGFuZCBldmVudHVhbGx5IHBhc3NpbmcgdGhhdCB0byBKYXZhLgojCiMgICAgICAgV2hlcmUgdGhlIGluaGVyaXRlZCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgKERFRkFVTFRfSlZNX09QVFMsIEpBVkFfT1BUUywKIyAgICAgICBhbmQgR1JBRExFX09QVFMpIHJlbHkgb24gd29yZC1zcGxpdHRpbmcsIHRoaXMgaXMgcGVyZm9ybWVkIGV4cGxpY2l0bHk7CiMgICAgICAgc2VlIHRoZSBpbi1saW5lIGNvbW1lbnRzIGZvciBkZXRhaWxzLgojCiMgICAgICAgVGhlcmUgYXJlIHR3ZWFrcyBmb3Igc3BlY2lmaWMgb3BlcmF0aW5nIHN5c3RlbXMgc3VjaCBhcyBBSVgsIEN5Z1dpbiwKIyAgICAgICBEYXJ3aW4sIE1pbkdXLCBhbmQgTm9uU3RvcC4KIwojICAgKDMpIFRoaXMgc2NyaXB0IGlzIGdlbmVyYXRlZCBmcm9tIHRoZSBHcm9vdnkgdGVtcGxhdGUKIyAgICAgICBodHRwczovL2dpdGh1Yi5jb20vZ3JhZGxlL2dyYWRsZS9ibG9iL0hFQUQvc3VicHJvamVjdHMvcGx1Z2lucy9zcmMvbWFpbi9yZXNvdXJjZXMvb3JnL2dyYWRsZS9hcGkvaW50ZXJuYWwvcGx1Z2lucy91bml4U3RhcnRTY3JpcHQudHh0CiMgICAgICAgd2l0aGluIHRoZSBHcmFkbGUgcHJvamVjdC4KIwojICAgICAgIFlvdSBjYW4gZmluZCBHcmFkbGUgYXQgaHR0cHM6Ly9naXRodWIuY29tL2dyYWRsZS9ncmFkbGUvLgojCiMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIwoKIyBBdHRlbXB0IHRvIHNldCBBUFBfSE9NRQoKIyBSZXNvbHZlIGxpbmtzOiAkMCBtYXkgYmUgYSBsaW5rCmFwcF9wYXRoPSQwCgojIE5lZWQgdGhpcyBmb3IgZGFpc3ktY2hhaW5lZCBzeW1saW5rcy4Kd2hpbGUKICAgIEFQUF9IT01FPSR7YXBwX3BhdGglIiR7YXBwX3BhdGgjIyovfSJ9ICAjIGxlYXZlcyBhIHRyYWlsaW5nIC87IGVtcHR5IGlmIG5vIGxlYWRpbmcgcGF0aAogICAgWyAtaCAiJGFwcF9wYXRoIiBdCmRvCiAgICBscz0kKCBscyAtbGQgIiRhcHBfcGF0aCIgKQogICAgbGluaz0ke2xzIyonIC0+ICd9CiAgICBjYXNlICRsaW5rIGluICAgICAgICAgICAgICMoCiAgICAgIC8qKSAgIGFwcF9wYXRoPSRsaW5rIDs7ICMoCiAgICAgICopICAgIGFwcF9wYXRoPSRBUFBfSE9NRSRsaW5rIDs7CiAgICBlc2FjCmRvbmUKCiMgVGhpcyBpcyBub3JtYWxseSB1bnVzZWQKIyBzaGVsbGNoZWNrIGRpc2FibGU9U0MyMDM0CkFQUF9CQVNFX05BTUU9JHswIyMqL30KIyBEaXNjYXJkIGNkIHN0YW5kYXJkIG91dHB1dCBpbiBjYXNlICRDRFBBVEggaXMgc2V0IChodHRwczovL2dpdGh1Yi5jb20vZ3JhZGxlL2dyYWRsZS9pc3N1ZXMvMjUwMzYpCkFQUF9IT01FPSQoIGNkICIke0FQUF9IT01FOi0uL30iID4gL2Rldi9udWxsICYmIHB3ZCAtUCApIHx8IGV4aXQKCiMgVXNlIHRoZSBtYXhpbXVtIGF2YWlsYWJsZSwgb3Igc2V0IE1BWF9GRCAhPSAtMSB0byB1c2UgdGhhdCB2YWx1ZS4KTUFYX0ZEPW1heGltdW0KCndhcm4gKCkgewogICAgZWNobyAiJCoiCn0gPiYyCgpkaWUgKCkgewogICAgZWNobwogICAgZWNobyAiJCoiCiAgICBlY2hvCiAgICBleGl0IDEKfSA+JjIKCiMgT1Mgc3BlY2lmaWMgc3VwcG9ydCAobXVzdCBiZSAndHJ1ZScgb3IgJ2ZhbHNlJykuCmN5Z3dpbj1mYWxzZQptc3lzPWZhbHNlCmRhcndpbj1mYWxzZQpub25zdG9wPWZhbHNlCmNhc2UgIiQoIHVuYW1lICkiIGluICAgICAgICAgICAgICAgICMoCiAgQ1lHV0lOKiApICAgICAgICAgY3lnd2luPXRydWUgIDs7ICMoCiAgRGFyd2luKiApICAgICAgICAgZGFyd2luPXRydWUgIDs7ICMoCiAgTVNZUyogfCBNSU5HVyogKSAgbXN5cz10cnVlICAgIDs7ICMoCiAgTk9OU1RPUCogKSAgICAgICAgbm9uc3RvcD10cnVlIDs7CmVzYWMKCkNMQVNTUEFUSD0kQVBQX0hPTUUvZ3JhZGxlL3dyYXBwZXIvZ3JhZGxlLXdyYXBwZXIuamFyCgoKIyBEZXRlcm1pbmUgdGhlIEphdmEgY29tbWFuZCB0byB1c2UgdG8gc3RhcnQgdGhlIEpWTS4KaWYgWyAtbiAiJEpBVkFfSE9NRSIgXSA7IHRoZW4KICAgIGlmIFsgLXggIiRKQVZBX0hPTUUvanJlL3NoL2phdmEiIF0gOyB0aGVuCiAgICAgICAgIyBJQk0ncyBKREsgb24gQUlYIHVzZXMgc3RyYW5nZSBsb2NhdGlvbnMgZm9yIHRoZSBleGVjdXRhYmxlcwogICAgICAgIEpBVkFDTUQ9JEpBVkFfSE9NRS9qcmUvc2gvamF2YQogICAgZWxzZQogICAgICAgIEpBVkFDTUQ9JEpBVkFfSE9NRS9iaW4vamF2YQogICAgZmkKICAgIGlmIFsgISAteCAiJEpBVkFDTUQiIF0gOyB0aGVuCiAgICAgICAgZGllICJFUlJPUjogSkFWQV9IT01FIGlzIHNldCB0byBhbiBpbnZhbGlkIGRpcmVjdG9yeTogJEpBVkFfSE9NRQoKUGxlYXNlIHNldCB0aGUgSkFWQV9IT01FIHZhcmlhYmxlIGluIHlvdXIgZW52aXJvbm1lbnQgdG8gbWF0Y2ggdGhlCmxvY2F0aW9uIG9mIHlvdXIgSmF2YSBpbnN0YWxsYXRpb24uIgogICAgZmkKZWxzZQogICAgSkFWQUNNRD1qYXZhCiAgICBpZiAhIGNvbW1hbmQgLXYgamF2YSA+L2Rldi9udWxsIDI+JjEKICAgIHRoZW4KICAgICAgICBkaWUgIkVSUk9SOiBKQVZBX0hPTUUgaXMgbm90IHNldCBhbmQgbm8gJ2phdmEnIGNvbW1hbmQgY291bGQgYmUgZm91bmQgaW4geW91ciBQQVRILgoKUGxlYXNlIHNldCB0aGUgSkFWQV9IT01FIHZhcmlhYmxlIGluIHlvdXIgZW52aXJvbm1lbnQgdG8gbWF0Y2ggdGhlCmxvY2F0aW9uIG9mIHlvdXIgSmF2YSBpbnN0YWxsYXRpb24uIgogICAgZmkKZmkKCiMgSW5jcmVhc2UgdGhlIG1heGltdW0gZmlsZSBkZXNjcmlwdG9ycyBpZiB3ZSBjYW4uCmlmICEgIiRjeWd3aW4iICYmICEgIiRkYXJ3aW4iICYmICEgIiRub25zdG9wIiA7IHRoZW4KICAgIGNhc2UgJE1BWF9GRCBpbiAjKAogICAgICBtYXgqKQogICAgICAgICMgSW4gUE9TSVggc2gsIHVsaW1pdCAtSCBpcyB1bmRlZmluZWQuIFRoYXQncyB3aHkgdGhlIHJlc3VsdCBpcyBjaGVja2VkIHRvIHNlZSBpZiBpdCB3b3JrZWQuCiAgICAgICAgIyBzaGVsbGNoZWNrIGRpc2FibGU9U0MyMDM5LFNDMzA0NQogICAgICAgIE1BWF9GRD0kKCB1bGltaXQgLUggLW4gKSB8fAogICAgICAgICAgICB3YXJuICJDb3VsZCBub3QgcXVlcnkgbWF4aW11bSBmaWxlIGRlc2NyaXB0b3IgbGltaXQiCiAgICBlc2FjCiAgICBjYXNlICRNQVhfRkQgaW4gICMoCiAgICAgICcnIHwgc29mdCkgOjs7ICMoCiAgICAgICopCiAgICAgICAgIyBJbiBQT1NJWCBzaCwgdWxpbWl0IC1uIGlzIHVuZGVmaW5lZC4gVGhhdCdzIHdoeSB0aGUgcmVzdWx0IGlzIGNoZWNrZWQgdG8gc2VlIGlmIGl0IHdvcmtlZC4KICAgICAgICAjIHNoZWxsY2hlY2sgZGlzYWJsZT1TQzIwMzksU0MzMDQ1CiAgICAgICAgdWxpbWl0IC1uICIkTUFYX0ZEIiB8fAogICAgICAgICAgICB3YXJuICJDb3VsZCBub3Qgc2V0IG1heGltdW0gZmlsZSBkZXNjcmlwdG9yIGxpbWl0IHRvICRNQVhfRkQiCiAgICBlc2FjCmZpCgojIENvbGxlY3QgYWxsIGFyZ3VtZW50cyBmb3IgdGhlIGphdmEgY29tbWFuZCwgc3RhY2tpbmcgaW4gcmV2ZXJzZSBvcmRlcjoKIyAgICogYXJncyBmcm9tIHRoZSBjb21tYW5kIGxpbmUKIyAgICogdGhlIG1haW4gY2xhc3MgbmFtZQojICAgKiAtY2xhc3NwYXRoCiMgICAqIC1ELi4uYXBwbmFtZSBzZXR0aW5ncwojICAgKiAtLW1vZHVsZS1wYXRoIChvbmx5IGlmIG5lZWRlZCkKIyAgICogREVGQVVMVF9KVk1fT1BUUywgSkFWQV9PUFRTLCBhbmQgR1JBRExFX09QVFMgZW52aXJvbm1lbnQgdmFyaWFibGVzLgoKIyBGb3IgQ3lnd2luIG9yIE1TWVMsIHN3aXRjaCBwYXRocyB0byBXaW5kb3dzIGZvcm1hdCBiZWZvcmUgcnVubmluZyBqYXZhCmlmICIkY3lnd2luIiB8fCAiJG1zeXMiIDsgdGhlbgogICAgQVBQX0hPTUU9JCggY3lncGF0aCAtLXBhdGggLS1taXhlZCAiJEFQUF9IT01FIiApCiAgICBDTEFTU1BBVEg9JCggY3lncGF0aCAtLXBhdGggLS1taXhlZCAiJENMQVNTUEFUSCIgKQoKICAgIEpBVkFDTUQ9JCggY3lncGF0aCAtLXVuaXggIiRKQVZBQ01EIiApCgogICAgIyBOb3cgY29udmVydCB0aGUgYXJndW1lbnRzIC0ga2x1ZGdlIHRvIGxpbWl0IG91cnNlbHZlcyB0byAvYmluL3NoCiAgICBmb3IgYXJnIGRvCiAgICAgICAgaWYKICAgICAgICAgICAgY2FzZSAkYXJnIGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjKAogICAgICAgICAgICAgIC0qKSAgIGZhbHNlIDs7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgZG9uJ3QgbWVzcyB3aXRoIG9wdGlvbnMgIygKICAgICAgICAgICAgICAvPyopICB0PSR7YXJnIy99IHQ9LyR7dCUlLyp9ICAgICAgICAgICAgICAjIGxvb2tzIGxpa2UgYSBQT1NJWCBmaWxlcGF0aAogICAgICAgICAgICAgICAgICAgIFsgLWUgIiR0IiBdIDs7ICAgICAgICAgICAgICAgICAgICAgICMoCiAgICAgICAgICAgICAgKikgICAgZmFsc2UgOzsKICAgICAgICAgICAgZXNhYwogICAgICAgIHRoZW4KICAgICAgICAgICAgYXJnPSQoIGN5Z3BhdGggLS1wYXRoIC0taWdub3JlIC0tbWl4ZWQgIiRhcmciICkKICAgICAgICBmaQogICAgICAgICMgUm9sbCB0aGUgYXJncyBsaXN0IGFyb3VuZCBleGFjdGx5IGFzIG1hbnkgdGltZXMgYXMgdGhlIG51bWJlciBvZgogICAgICAgICMgYXJncywgc28gZWFjaCBhcmcgd2luZHMgdXAgYmFjayBpbiB0aGUgcG9zaXRpb24gd2hlcmUgaXQgc3RhcnRlZCwgYnV0CiAgICAgICAgIyBwb3NzaWJseSBtb2RpZmllZC4KICAgICAgICAjCiAgICAgICAgIyBOQjogYSBgZm9yYCBsb29wIGNhcHR1cmVzIGl0cyBpdGVyYXRpb24gbGlzdCBiZWZvcmUgaXQgYmVnaW5zLCBzbwogICAgICAgICMgY2hhbmdpbmcgdGhlIHBvc2l0aW9uYWwgcGFyYW1ldGVycyBoZXJlIGFmZmVjdHMgbmVpdGhlciB0aGUgbnVtYmVyIG9mCiAgICAgICAgIyBpdGVyYXRpb25zLCBub3IgdGhlIHZhbHVlcyBwcmVzZW50ZWQgaW4gYGFyZ2AuCiAgICAgICAgc2hpZnQgICAgICAgICAgICAgICAgICAgIyByZW1vdmUgb2xkIGFyZwogICAgICAgIHNldCAtLSAiJEAiICIkYXJnIiAgICAgICMgcHVzaCByZXBsYWNlbWVudCBhcmcKICAgIGRvbmUKZmkKCgojIEFkZCBkZWZhdWx0IEpWTSBvcHRpb25zIGhlcmUuIFlvdSBjYW4gYWxzbyB1c2UgSkFWQV9PUFRTIGFuZCBHUkFETEVfT1BUUyB0byBwYXNzIEpWTSBvcHRpb25zIHRvIHRoaXMgc2NyaXB0LgpERUZBVUxUX0pWTV9PUFRTPSctRGZpbGUuZW5jb2Rpbmc9VVRGLTggIi1YbXg2NG0iICItWG1zNjRtIicKCiMgQ29sbGVjdCBhbGwgYXJndW1lbnRzIGZvciB0aGUgamF2YSBjb21tYW5kOgojICAgKiBERUZBVUxUX0pWTV9PUFRTLCBKQVZBX09QVFMsIEpBVkFfT1BUUywgYW5kIG9wdHNFbnZpcm9ubWVudFZhciBhcmUgbm90IGFsbG93ZWQgdG8gY29udGFpbiBzaGVsbCBmcmFnbWVudHMsCiMgICAgIGFuZCBhbnkgZW1iZWRkZWQgc2hlbGxuZXNzIHdpbGwgYmUgZXNjYXBlZC4KIyAgICogRm9yIGV4YW1wbGU6IEEgdXNlciBjYW5ub3QgZXhwZWN0ICR7SG9zdG5hbWV9IHRvIGJlIGV4cGFuZGVkLCBhcyBpdCBpcyBhbiBlbnZpcm9ubWVudCB2YXJpYWJsZSBhbmQgd2lsbCBiZQojICAgICB0cmVhdGVkIGFzICcke0hvc3RuYW1lfScgaXRzZWxmIG9uIHRoZSBjb21tYW5kIGxpbmUuCgpzZXQgLS0gXAogICAgICAgICItRG9yZy5ncmFkbGUuYXBwbmFtZT0kQVBQX0JBU0VfTkFNRSIgXAogICAgICAgIC1jbGFzc3BhdGggIiRDTEFTU1BBVEgiIFwKICAgICAgICBvcmcuZ3JhZGxlLndyYXBwZXIuR3JhZGxlV3JhcHBlck1haW4gXAogICAgICAgICIkQCIKCiMgU3RvcCB3aGVuICJ4YXJncyIgaXMgbm90IGF2YWlsYWJsZS4KaWYgISBjb21tYW5kIC12IHhhcmdzID4vZGV2L251bGwgMj4mMQp0aGVuCiAgICBkaWUgInhhcmdzIGlzIG5vdCBhdmFpbGFibGUiCmZpCgojIFVzZSAieGFyZ3MiIHRvIHBhcnNlIHF1b3RlZCBhcmdzLgojCiMgV2l0aCAtbjEgaXQgb3V0cHV0cyBvbmUgYXJnIHBlciBsaW5lLCB3aXRoIHRoZSBxdW90ZXMgYW5kIGJhY2tzbGFzaGVzIHJlbW92ZWQuCiMKIyBJbiBCYXNoIHdlIGNvdWxkIHNpbXBseSBnbzoKIwojICAgcmVhZGFycmF5IEFSR1MgPCA8KCB4YXJncyAtbjEgPDw8IiR2YXIiICkgJiYKIyAgIHNldCAtLSAiJHtBUkdTW0BdfSIgIiRAIgojCiMgYnV0IFBPU0lYIHNoZWxsIGhhcyBuZWl0aGVyIGFycmF5cyBub3IgY29tbWFuZCBzdWJzdGl0dXRpb24sIHNvIGluc3RlYWQgd2UKIyBwb3N0LXByb2Nlc3MgZWFjaCBhcmcgKGFzIGEgbGluZSBvZiBpbnB1dCB0byBzZWQpIHRvIGJhY2tzbGFzaC1lc2NhcGUgYW55CiMgY2hhcmFjdGVyIHRoYXQgbWlnaHQgYmUgYSBzaGVsbCBtZXRhY2hhcmFjdGVyLCB0aGVuIHVzZSBldmFsIHRvIHJldmVyc2UKIyB0aGF0IHByb2Nlc3MgKHdoaWxlIG1haW50YWluaW5nIHRoZSBzZXBhcmF0aW9uIGJldHdlZW4gYXJndW1lbnRzKSwgYW5kIHdyYXAKIyB0aGUgd2hvbGUgdGhpbmcgdXAgYXMgYSBzaW5nbGUgInNldCIgc3RhdGVtZW50LgojCiMgVGhpcyB3aWxsIG9mIGNvdXJzZSBicmVhayBpZiBhbnkgb2YgdGhlc2UgdmFyaWFibGVzIGNvbnRhaW5zIGEgbmV3bGluZSBvcgojIGFuIHVubWF0Y2hlZCBxdW90ZS4KIwoKZXZhbCAic2V0IC0tICQoCiAgICAgICAgcHJpbnRmICclc1xuJyAiJERFRkFVTFRfSlZNX09QVFMgJEpBVkFfT1BUUyAkR1JBRExFX09QVFMiIHwKICAgICAgICB4YXJncyAtbjEgfAogICAgICAgIHNlZCAnIHN+W14tWzphbG51bTpdKywuLzo9QF9dflxcJn5nOyAnIHwKICAgICAgICB0ciAnXG4nICcgJwogICAgKSIgJyIkQCInCgpleGVjICIkSkFWQUNNRCIgIiRAIgo=";
var GRADLEW_BAT_B64 = "QHJlbQpAcmVtIENvcHlyaWdodCAyMDE1IHRoZSBvcmlnaW5hbCBhdXRob3Igb3IgYXV0aG9ycy4KQHJlbQpAcmVtIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSAiTGljZW5zZSIpOwpAcmVtIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS4KQHJlbSBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXQKQHJlbQpAcmVtICAgICAgaHR0cHM6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMApAcmVtCkByZW0gVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZQpAcmVtIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuICJBUyBJUyIgQkFTSVMsCkByZW0gV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuCkByZW0gU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZApAcmVtIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLgpAcmVtCgpAaWYgIiVERUJVRyUiPT0iIiBAZWNobyBvZmYKQHJlbSAjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIwpAcmVtCkByZW0gIEdyYWRsZSBzdGFydHVwIHNjcmlwdCBmb3IgV2luZG93cwpAcmVtCkByZW0gIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMKCkByZW0gU2V0IGxvY2FsIHNjb3BlIGZvciB0aGUgdmFyaWFibGVzIHdpdGggd2luZG93cyBOVCBzaGVsbAppZiAiJU9TJSI9PSJXaW5kb3dzX05UIiBzZXRsb2NhbAoKc2V0IERJUk5BTUU9JX5kcDAKaWYgIiVESVJOQU1FJSI9PSIiIHNldCBESVJOQU1FPS4KQHJlbSBUaGlzIGlzIG5vcm1hbGx5IHVudXNlZApzZXQgQVBQX0JBU0VfTkFNRT0lfm4wCnNldCBBUFBfSE9NRT0lRElSTkFNRSUKCkByZW0gUmVzb2x2ZSBhbnkgIi4iIGFuZCAiLi4iIGluIEFQUF9IT01FIHRvIG1ha2UgaXQgc2hvcnRlci4KZm9yICUlaSBpbiAoIiVBUFBfSE9NRSUiKSBkbyBzZXQgQVBQX0hPTUU9JSV+ZmkKCkByZW0gQWRkIGRlZmF1bHQgSlZNIG9wdGlvbnMgaGVyZS4gWW91IGNhbiBhbHNvIHVzZSBKQVZBX09QVFMgYW5kIEdSQURMRV9PUFRTIHRvIHBhc3MgSlZNIG9wdGlvbnMgdG8gdGhpcyBzY3JpcHQuCnNldCBERUZBVUxUX0pWTV9PUFRTPS1EZmlsZS5lbmNvZGluZz1VVEYtOCAiLVhteDY0bSIgIi1YbXM2NG0iCgpAcmVtIEZpbmQgamF2YS5leGUKaWYgZGVmaW5lZCBKQVZBX0hPTUUgZ290byBmaW5kSmF2YUZyb21KYXZhSG9tZQoKc2V0IEpBVkFfRVhFPWphdmEuZXhlCiVKQVZBX0VYRSUgLXZlcnNpb24gPk5VTCAyPiYxCmlmICVFUlJPUkxFVkVMJSBlcXUgMCBnb3RvIGV4ZWN1dGUKCmVjaG8uIDE+JjIKZWNobyBFUlJPUjogSkFWQV9IT01FIGlzIG5vdCBzZXQgYW5kIG5vICdqYXZhJyBjb21tYW5kIGNvdWxkIGJlIGZvdW5kIGluIHlvdXIgUEFUSC4gMT4mMgplY2hvLiAxPiYyCmVjaG8gUGxlYXNlIHNldCB0aGUgSkFWQV9IT01FIHZhcmlhYmxlIGluIHlvdXIgZW52aXJvbm1lbnQgdG8gbWF0Y2ggdGhlIDE+JjIKZWNobyBsb2NhdGlvbiBvZiB5b3VyIEphdmEgaW5zdGFsbGF0aW9uLiAxPiYyCgpnb3RvIGZhaWwKCjpmaW5kSmF2YUZyb21KYXZhSG9tZQpzZXQgSkFWQV9IT01FPSVKQVZBX0hPTUU6Ij0lCnNldCBKQVZBX0VYRT0lSkFWQV9IT01FJS9iaW4vamF2YS5leGUKCmlmIGV4aXN0ICIlSkFWQV9FWEUlIiBnb3RvIGV4ZWN1dGUKCmVjaG8uIDE+JjIKZWNobyBFUlJPUjogSkFWQV9IT01FIGlzIHNldCB0byBhbiBpbnZhbGlkIGRpcmVjdG9yeTogJUpBVkFfSE9NRSUgMT4mMgplY2hvLiAxPiYyCmVjaG8gUGxlYXNlIHNldCB0aGUgSkFWQV9IT01FIHZhcmlhYmxlIGluIHlvdXIgZW52aXJvbm1lbnQgdG8gbWF0Y2ggdGhlIDE+JjIKZWNobyBsb2NhdGlvbiBvZiB5b3VyIEphdmEgaW5zdGFsbGF0aW9uLiAxPiYyCgpnb3RvIGZhaWwKCjpleGVjdXRlCkByZW0gU2V0dXAgdGhlIGNvbW1hbmQgbGluZQoKc2V0IENMQVNTUEFUSD0lQVBQX0hPTUUlXGdyYWRsZVx3cmFwcGVyXGdyYWRsZS13cmFwcGVyLmphcgoKCkByZW0gRXhlY3V0ZSBHcmFkbGUKIiVKQVZBX0VYRSUiICVERUZBVUxUX0pWTV9PUFRTJSAlSkFWQV9PUFRTJSAlR1JBRExFX09QVFMlICItRG9yZy5ncmFkbGUuYXBwbmFtZT0lQVBQX0JBU0VfTkFNRSUiIC1jbGFzc3BhdGggIiVDTEFTU1BBVEglIiBvcmcuZ3JhZGxlLndyYXBwZXIuR3JhZGxlV3JhcHBlck1haW4gJSoKCjplbmQKQHJlbSBFbmQgbG9jYWwgc2NvcGUgZm9yIHRoZSB2YXJpYWJsZXMgd2l0aCB3aW5kb3dzIE5UIHNoZWxsCmlmICVFUlJPUkxFVkVMJSBlcXUgMCBnb3RvIG1haW5FbmQKCjpmYWlsCnJlbSBTZXQgdmFyaWFibGUgR1JBRExFX0VYSVRfQ09OU09MRSBpZiB5b3UgbmVlZCB0aGUgX3NjcmlwdF8gcmV0dXJuIGNvZGUgaW5zdGVhZCBvZgpyZW0gdGhlIF9jbWQuZXhlIC9jXyByZXR1cm4gY29kZSEKc2V0IEVYSVRfQ09ERT0lRVJST1JMRVZFTCUKaWYgJUVYSVRfQ09ERSUgZXF1IDAgc2V0IEVYSVRfQ09ERT0xCmlmIG5vdCAiIj09IiVHUkFETEVfRVhJVF9DT05TT0xFJSIgZXhpdCAlRVhJVF9DT0RFJQpleGl0IC9iICVFWElUX0NPREUlCgo6bWFpbkVuZAppZiAiJU9TJSI9PSJXaW5kb3dzX05UIiBlbmRsb2NhbAoKOm9tZWdhCg==";

var el = function (id) { return document.getElementById(id); };
var drop = el('drop');
var fileInput = el('file');
var goBtn = el('go');
var logEl = el('log');
var treeEl = el('tree');
var resultEl = el('result');

var ICON_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
var iconPngDataUrls = null; // { mdpi: 'data:image/png;base64,...', ... }

function selectedPermissions() {
    return Array.prototype.slice.call(document.querySelectorAll('.perm:checked'))
        .map(function (cb) { return cb.value; });
}

function processIcon(file) {
    return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
            try {
                var pngs = {};
                Object.keys(ICON_SIZES).forEach(function (density) {
                    var size = ICON_SIZES[density];
                    var canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    var ctx = canvas.getContext('2d');
                    var side = Math.min(img.width, img.height);
                    var sx = (img.width - side) / 2;
                    var sy = (img.height - side) / 2;
                    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
                    pngs[density] = canvas.toDataURL('image/png');
                });
                resolve({ pngs: pngs, previewUrl: url });
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = function () { reject(new Error('Could not load that image.')); };
        img.src = url;
    });
}

function dataUrlToUint8Array(dataUrl) {
    var binary = atob(dataUrl.split(',')[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

el('iconFile').addEventListener('change', function () {
    var file = this.files[0];
    if (!file) { iconPngDataUrls = null; el('iconPreview').hidden = true; return; }
    processIcon(file).then(function (result) {
        iconPngDataUrls = result.pngs;
        el('iconPreviewImg').src = result.previewUrl;
        el('iconPreviewMeta').textContent = file.name;
        el('iconPreview').hidden = false;
        el('iconFileError').textContent = '';
    }).catch(function (err) {
        iconPngDataUrls = null;
        el('iconPreview').hidden = true;
        el('iconFileError').textContent = err.message || 'Could not process that image.';
    });
});

var selectedFile = null;
var currentUrl = null;

function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function slug(name) {
    return name.toLowerCase().replace(/\.zip$/, '').replace(/[^a-z0-9]+/g, '').replace(/^[0-9]+/, '') || 'webapp';
}

function titleize(name) {
    var base = name.replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').trim();
    if (!base) return 'My Web App';
    return base.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function setFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
        logReset();
        logLine('Please choose a .zip file.', true);
        return;
    }
    selectedFile = file;
    el('dropIdle').hidden = true;
    el('dropLoaded').hidden = false;
    drop.classList.add('loaded');
    el('fileName').textContent = file.name;
    el('fileMeta').textContent = fmtBytes(file.size);

    if (!el('appName').value) el('appName').value = titleize(file.name);
    if (!el('pkgName').value) el('pkgName').value = 'com.example.' + slug(file.name);
    validate();
}

drop.addEventListener('click', function () { fileInput.click(); });
fileInput.addEventListener('change', function () { setFile(fileInput.files[0]); });

['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); });
});
['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
        e.preventDefault();
        if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
        drop.classList.remove('hot');
    });
});
drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        setFile(e.dataTransfer.files[0]);
    }
});

function validate() {
    var pkg = el('pkgName').value.trim();
    var appName = el('appName').value.trim();
    var pkgErr = pkg ? window.AndroidWrapper.validatePackage(pkg) : null;

    el('pkgNameError').textContent = pkg && pkgErr ? pkgErr : '';
    el('pkgName').classList.toggle('invalid', !!(pkg && pkgErr));
    el('appNameError').textContent = '';

    var admobOn = el('optAdmob').checked;
    var useTestAds = el('optAdmobTestAds').checked;
    var admobOk = true;

    if (admobOn && !useTestAds) {
        var appId = el('admobAppId').value.trim();
        var unitId = el('admobBannerUnitId').value.trim();
        var appIdErr = window.AndroidWrapper.validateAdmobAppId(appId);
        var unitIdErr = window.AndroidWrapper.validateAdmobAdUnitId(unitId);
        el('admobAppIdError').textContent = appIdErr || '';
        el('admobAppId').classList.toggle('invalid', !!appIdErr);
        el('admobBannerUnitIdError').textContent = unitIdErr || '';
        el('admobBannerUnitId').classList.toggle('invalid', !!unitIdErr);
        admobOk = !appIdErr && !unitIdErr;
    } else {
        el('admobAppIdError').textContent = '';
        el('admobAppId').classList.remove('invalid');
        el('admobBannerUnitIdError').textContent = '';
        el('admobBannerUnitId').classList.remove('invalid');
    }

    var ready = selectedFile && appName && pkg && !pkgErr && admobOk;
    goBtn.disabled = !ready;
    return ready;
}

el('optAdmob').addEventListener('change', function () {
    el('admobPanel').hidden = !this.checked;
    validate();
});

el('optAdmobTestAds').addEventListener('change', function () {
    el('admobAppId').disabled = this.checked;
    el('admobBannerUnitId').disabled = this.checked;
    validate();
});

el('admobAppId').addEventListener('input', validate);
el('admobBannerUnitId').addEventListener('input', validate);

el('appName').addEventListener('input', validate);
el('pkgName').addEventListener('input', validate);

function logReset() { logEl.innerHTML = ''; }
function logLine(text, isError) {
    var line = document.createElement('div');
    line.className = 'line' + (isError ? ' err' : '');
    var mark = document.createElement('span');
    mark.className = 'mark' + (isError ? ' err' : '');
    mark.textContent = isError ? 'x' : '>';
    var body = document.createElement('span');
    body.textContent = text;
    line.appendChild(mark);
    line.appendChild(body);
    logEl.appendChild(line);
}

function renderTree(paths) {
    treeEl.innerHTML = '';
    var tree = {};
    paths.forEach(function (p) {
        var parts = p.split('/');
        var node = tree;
        parts.forEach(function (part, i) {
            var isLeaf = i === parts.length - 1;
            if (!node[part]) node[part] = { __leaf: isLeaf, __children: {} };
            node = node[part].__children;
        });
    });

    var rows = [];
    function walk(node, depth, prefixAsset) {
        var keys = Object.keys(node).sort(function (a, b) {
            var ad = Object.keys(node[a].__children).length > 0;
            var bd = Object.keys(node[b].__children).length > 0;
            if (ad !== bd) return ad ? -1 : 1;
            return a.localeCompare(b);
        });
        keys.forEach(function (key) {
            var entry = node[key];
            var isDir = Object.keys(entry.__children).length > 0;
            var indent = '  '.repeat(depth);
            var asset = prefixAsset || key === 'www';
            var cls = isDir ? 'dir' : (asset ? 'leaf asset' : 'leaf');
            rows.push({ text: indent + (isDir ? key + '/' : key), cls: cls });
            if (isDir) walk(entry.__children, depth + 1, asset);
        });
    }
    walk(tree, 0, false);

    rows.forEach(function (r) {
        var div = document.createElement('div');
        div.className = 'row-t ' + r.cls;
        div.textContent = r.text;
        treeEl.appendChild(div);
    });
}

function reader(file) {
    return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(new Error('Could not read the file.')); };
        r.readAsArrayBuffer(file);
    });
}

goBtn.addEventListener('click', function () {
    if (!validate()) return;
    goBtn.disabled = true;
    resultEl.classList.remove('show');
    treeEl.innerHTML = '';
    logReset();

    var appName = el('appName').value.trim();
    var pkg = el('pkgName').value.trim();

    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }

    logLine('Reading ' + selectedFile.name);

    reader(selectedFile).then(function (buffer) {
        logLine('Unpacking web app and locating index.html');

        var iconPngs = null;
        if (iconPngDataUrls) {
            iconPngs = {};
            Object.keys(iconPngDataUrls).forEach(function (d) {
                iconPngs[d] = dataUrlToUint8Array(iconPngDataUrls[d]);
            });
        }

        var admob = el('optAdmob').checked ? {
            enabled: true,
            useTestAds: el('optAdmobTestAds').checked,
            appId: el('admobAppId').value.trim(),
            bannerUnitId: el('admobBannerUnitId').value.trim()
        } : null;

        return window.AndroidWrapper.generateProject({
            zipData: buffer,
            appName: appName,
            packageName: pkg,
            minSdk: el('minSdk').value,
            includeInternet: el('optInternet').checked,
            allowCleartext: el('optCleartext').checked,
            permissions: selectedPermissions(),
            iconPngs: iconPngs,
            admob: admob,
            outputType: 'blob'
        }, {
            JSZip: window.JSZip,
            wrapperJarB64: WRAPPER_JAR_B64,
            gradlewB64: GRADLEW_B64,
            gradlewBatB64: GRADLEW_BAT_B64
        });
    }).then(function (result) {
        var rootLabel = result.webRoot ? result.webRoot : '(zip root)';
        logLine('Web root: ' + rootLabel);
        logLine('Copied ' + result.fileCount + ' web files into assets/www');
        logLine('Wrote Gradle project, manifest, and MainActivity');
        logLine('Done. ' + result.entries.length + ' files in the project.');

        renderTree(result.entries);

        currentUrl = URL.createObjectURL(result.payload);
        var dl = el('download');
        dl.href = currentUrl;
        dl.download = slug(appName || selectedFile.name) + '-android.zip';
        el('summary').innerHTML = 'Project ready: <b>' + result.entries.length +
            '</b> files, <b>' + fmtBytes(result.payload.size) + '</b> zipped.';
        resultEl.classList.add('show');
        goBtn.disabled = false;
    }).catch(function (err) {
        logLine(err && err.message ? err.message : 'Something went wrong.', true);
        goBtn.disabled = false;
    });
});

window.addEventListener('beforeunload', function () {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
});