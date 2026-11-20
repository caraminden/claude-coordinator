package zip.citadel.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** #64: a load that never answers ends on the offline page, not a black screen for minutes. */
public class LoadWatchdogTest {

    /** A timer that runs nothing until the test says time has passed. */
    static final class FakeTimer implements LoadWatchdog.Timer {
        final List<Runnable> pending = new ArrayList<>();
        long lastDelay;

        @Override
        public void schedule(Runnable task, long delayMs) {
            pending.add(task);
            lastDelay = delayMs;
        }

        @Override
        public void cancel(Runnable task) {
            pending.remove(task);
        }

        void elapse() {
            List<Runnable> due = new ArrayList<>(pending);
            pending.clear();
            for (Runnable r : due) r.run();
        }
    }

    private final FakeTimer timer = new FakeTimer();
    private int offline;
    private final LoadWatchdog dog = new LoadWatchdog(timer, () -> offline++);

    @Test
    public void aLoadThatShowsNothingOpensTheOfflinePage() {
        dog.started();
        assertEquals(LoadWatchdog.TIMEOUT_MS, timer.lastDelay);
        timer.elapse();
        assertEquals(1, offline);
        assertFalse(dog.armed());
    }

    @Test
    public void aLoadThatPaintsInTimeIsLeftAlone() {
        dog.started();
        dog.settled();
        timer.elapse();
        assertEquals(0, offline);
    }

    @Test
    public void theOfflinePageSettlesItsOwnWatch() {
        dog.started();
        timer.elapse(); // gave up: the listener opens the offline page
        dog.started(); // the offline page starts
        dog.settled(); // and shows at once (it is bundled)
        timer.elapse();
        assertEquals(1, offline);
    }

    @Test
    public void eachNewLoadGetsItsOwnTimeOnlyOnce() {
        dog.started(); // the shell's first load
        dog.started(); // a redirect to sign-in starts another
        assertEquals(1, timer.pending.size());
        assertTrue(dog.armed());
        timer.elapse();
        assertEquals(1, offline);
    }

    @Test
    public void tryAgainFromTheOfflinePageIsWatchedAgain() {
        dog.started();
        timer.elapse();
        dog.started(); // the offline page
        dog.settled();
        dog.started(); // Try again
        timer.elapse();
        assertEquals(2, offline);
    }

    @Test
    public void aJumpToATabOnTheSamePageIsNotALoad() {
        String today = "https://voice.citadel.zip/apps/voice/#today";
        assertFalse(LoadWatchdog.leavesPage("https://voice.citadel.zip/apps/voice/#progress", today));
        assertFalse(LoadWatchdog.leavesPage("https://voice.citadel.zip/apps/voice/", today));
    }

    @Test
    public void tryAgainLeavesTheOfflinePage() {
        assertTrue(LoadWatchdog.leavesPage("https://voice.citadel.zip/apps/voice/", "https://localhost/offline.html"));
        assertTrue(LoadWatchdog.leavesPage("https://voice.citadel.zip/apps/voice/", null));
        assertTrue(LoadWatchdog.leavesPage("https://voice.citadel.zip/sign-in", "https://voice.citadel.zip/apps/voice/#today"));
    }
}
