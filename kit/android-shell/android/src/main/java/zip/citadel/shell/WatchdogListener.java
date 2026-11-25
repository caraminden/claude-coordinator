package zip.citadel.shell;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import com.getcapacitor.Bridge;

/**
 * Feeds the WebView's page events to a {@link LoadWatchdog}; on a timeout, stops the load and opens the offline page.
 *
 * {@link ShellWebViewClient} calls it directly. It is not one of Capacitor's WebViewListeners: a plugin's load() runs
 * inside Bridge's constructor, and Bridge.Builder then replaces the listener list with its own, so a listener added
 * there never hears a page finish and the watchdog opened the offline page 20 s after every launch (#1138).
 */
final class WatchdogListener {

    private final Bridge bridge;
    private final LoadWatchdog watchdog;

    public WatchdogListener(Bridge bridge) {
        this.bridge = bridge;
        Handler main = new Handler(Looper.getMainLooper());
        this.watchdog = new LoadWatchdog(
            new LoadWatchdog.Timer() {
                @Override
                public void schedule(Runnable task, long delayMs) {
                    main.postDelayed(task, delayMs);
                }

                @Override
                public void cancel(Runnable task) {
                    main.removeCallbacks(task);
                }
            },
            this::showOffline
        );
    }

    /** Watch the first load, which Capacitor may have started before this listener was added. */
    public void watchFirstLoad() {
        watchdog.started();
    }

    /** The page is about to leave for another document (the offline page's Try again, a redirect). */
    public void navigationStarted() {
        watchdog.started();
    }

    /** The load being watched ended with no page (a download, a link opened outside): the one on screen stays. */
    void leftAsIs() {
        watchdog.leftAsIs();
    }

    void onPageStarted(WebView view) {
        // Chromium's WebView calls this once the new page has answered (at commit), not when it is asked for,
        // so a load that never answers is watched from navigationStarted or watchFirstLoad instead. A page that
        // answered but paints nothing for TIMEOUT_MS still ends on the offline page.
        watchdog.started();
    }

    void onPageCommitVisible(WebView view, String url) {
        watchdog.settled();
    }

    void onPageLoaded(WebView view) {
        watchdog.settled();
    }

    void onReceivedError(WebView view) {
        watchdog.settled();
    }

    void onReceivedHttpError(WebView view) {
        watchdog.settled();
    }

    private void showOffline() {
        String offline = bridge.getErrorUrl();
        if (offline == null) return;
        WebView view = bridge.getWebView();
        view.stopLoading();
        view.loadUrl(offline);
    }
}
