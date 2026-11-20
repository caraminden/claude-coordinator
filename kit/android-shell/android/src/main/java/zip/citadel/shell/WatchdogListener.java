package zip.citadel.shell;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

/** Feeds the WebView's page events to a {@link LoadWatchdog}; on a timeout, stops the load and opens the offline page. */
final class WatchdogListener extends WebViewListener {

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

    @Override
    public void onPageStarted(WebView view) {
        // Chromium's WebView calls this once the new page has answered (at commit), not when it is asked for,
        // so a load that never answers is watched from navigationStarted or watchFirstLoad instead. A page that
        // answered but paints nothing for TIMEOUT_MS still ends on the offline page.
        watchdog.started();
    }

    @Override
    public void onPageCommitVisible(WebView view, String url) {
        watchdog.settled();
    }

    @Override
    public void onPageLoaded(WebView view) {
        watchdog.settled();
    }

    @Override
    public void onReceivedError(WebView view) {
        watchdog.settled();
    }

    @Override
    public void onReceivedHttpError(WebView view) {
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
