package zip.citadel.shell;

/**
 * Shows the offline page when the app's address doesn't answer (from Voice #64, shared by #1138).
 *
 * Capacitor's errorPath only appears once the WebView gives up on a load, and when the phone has a
 * route to the app that goes nowhere (Tailscale on but not really connected) that takes minutes. Until
 * then the WebView has painted nothing, so the app is a plain black screen (Voice #64). This gives each
 * page load {@link #TIMEOUT_MS} to show something; if it hasn't, it stops the load and opens the
 * offline page with its Try again button.
 *
 * Plain Java with the timer passed in, so the JVM tests can drive it; {@link WatchdogListener}
 * wires it to the WebView.
 */
public final class LoadWatchdog {

    /** How long a page load may show nothing. A contraption's first page is a few kB of HTML, so 20 s is a dead connection. */
    public static final long TIMEOUT_MS = 20_000;

    /** A one-shot timer: Android's Handler in the app, a fake in tests. */
    public interface Timer {
        void schedule(Runnable task, long delayMs);

        void cancel(Runnable task);
    }

    private final Timer timer;
    private final Runnable giveUp;
    private final Runnable fire = this::fire;
    private boolean armed;
    private boolean shown;

    /** {@code giveUp} runs on the timer's thread when a load showed nothing in time. */
    public LoadWatchdog(Timer timer, Runnable giveUp) {
        this.timer = timer;
        this.giveUp = giveUp;
    }

    /** A page load started: this one gets its own {@link #TIMEOUT_MS}. The offline page is bundled, so it settles at once. */
    public void started() {
        disarm();
        armed = true;
        timer.schedule(fire, TIMEOUT_MS);
    }

    /** The page painted something, finished, or failed (Capacitor then shows the offline page itself). */
    public void settled() {
        shown = true;
        disarm();
    }

    /**
     * The load ended without a page of its own (it was a download, or opened outside the app). The page on screen stays,
     * so there is nothing to wait for; with none yet (the first load), the offline page is still due.
     */
    public void leftAsIs() {
        if (shown) disarm();
    }

    public boolean armed() {
        return armed;
    }

    /**
     * Whether a navigation to {@code target} leaves the page at {@code current}. A jump to a
     * {@code #tab} on the same page loads nothing and reports nothing back, so watching it would
     * open the offline page over a working app.
     */
    public static boolean leavesPage(String target, String current) {
        if (target == null || current == null) return true;
        return !withoutFragment(target).equals(withoutFragment(current));
    }

    private static String withoutFragment(String url) {
        int hash = url.indexOf('#');
        return hash < 0 ? url : url.substring(0, hash);
    }

    private void disarm() {
        if (armed) timer.cancel(fire);
        armed = false;
    }

    private void fire() {
        if (!armed) return;
        armed = false;
        giveUp.run();
    }
}
