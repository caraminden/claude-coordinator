package zip.citadel.shell;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Capacitor's client with the shell's three changes (#1138):
 * <ul>
 *   <li>Citadel's pages other than sign-in open outside the app ({@link Links}, from Mandate #127).</li>
 *   <li>Only a gateway error (502, 503, 504: Citadel or the app down) shows the offline page. Capacitor shows it for
 *       any HTTP error on the main page, which hid the app's own answers, such as Citadel's "you don't have this
 *       app" page (from Mandate).</li>
 *   <li>A load leaving for another document is watched by the {@link WatchdogListener}: no WebViewListener callback
 *       fires at that moment, so without this the offline page's Try again went unwatched (from Voice #64).</li>
 * </ul>
 */
final class ShellWebViewClient extends BridgeWebViewClient {

    private final Bridge bridge;
    private final WatchdogListener watchdog;
    private final String self;
    private final String citadelHost;

    ShellWebViewClient(Bridge bridge, WatchdogListener watchdog, String self, String citadelHost) {
        super(bridge);
        this.bridge = bridge;
        this.watchdog = watchdog;
        this.self = self;
        this.citadelHost = citadelHost;
    }

    // Main frame only: also called for a server redirect, so an app-host link Citadel bounces to its own host is caught.
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (request.isForMainFrame()) {
            String out = Links.outside(request.getUrl().toString(), Uri.parse(bridge.getAppUrl()).getHost(), citadelHost, self);
            if (out != null) {
                try {
                    bridge.getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(out)).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException e) {
                    // No browser at all: stay on the app rather than load Citadel in its window.
                }
                return true;
            }
        }
        boolean handledElsewhere = super.shouldOverrideUrlLoading(view, request);
        // An outside link opens in the browser and leaves this page alone; only a load in this WebView is watched.
        if (!handledElsewhere && request.isForMainFrame() && LoadWatchdog.leavesPage(request.getUrl().toString(), view.getUrl())) {
            watchdog.navigationStarted();
        }
        return handledElsewhere;
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        // Not super: it loads the offline page for every status, and it is the only way Capacitor's WebViewListeners
        // hear of an HTTP error, so the watchdog is told here directly.
        if (!request.isForMainFrame()) return;
        watchdog.onReceivedHttpError(view);
        int status = response.getStatusCode();
        String errorUrl = bridge.getErrorUrl();
        if (errorUrl != null && (status == 502 || status == 503 || status == 504)) view.loadUrl(errorUrl);
    }
}
