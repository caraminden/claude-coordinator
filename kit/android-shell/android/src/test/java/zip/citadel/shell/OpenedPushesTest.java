package zip.citadel.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** #1941: an intent Android hands back (Recents, a dead process) doesn't reopen a notification's page. */
public class OpenedPushesTest {

    @Test
    public void aPushOpensOnce() {
        String seen = OpenedPushes.use(null, "a");
        assertEquals("a", seen);
        assertNull(OpenedPushes.use(seen, "a"));
        assertEquals("a,b", OpenedPushes.use(seen, "b"));
    }

    @Test
    public void theTasksFirstIntentStaysUsedAfterLaterTaps() {
        // Cold start on push a, later taps b and c; Android then redelivers a, not c.
        String seen = OpenedPushes.use(OpenedPushes.use(OpenedPushes.use(null, "a"), "b"), "c");
        assertNull(OpenedPushes.use(seen, "a"));
        assertNull(OpenedPushes.use(seen, "c"));
    }

    @Test
    public void theSamePageAgainFromANewPushOpens() {
        // Two pushes can open one page; only the push's own id counts.
        assertNotNull(OpenedPushes.use(OpenedPushes.use(null, "first"), "second"));
    }

    @Test
    public void anIntentWithNoIdIsNotAPush() {
        assertNull(OpenedPushes.use(null, null));
        assertNull(OpenedPushes.use("a", ""));
    }

    @Test
    public void onlyTheNewestIdsAreKept() {
        String seen = null;
        for (int i = 0; i < OpenedPushes.KEPT + 5; i++) seen = OpenedPushes.use(seen, "id" + i);
        assertEquals(OpenedPushes.KEPT, seen.split(",").length);
        assertNull(OpenedPushes.use(seen, "id" + (OpenedPushes.KEPT + 4)));
        assertNull(OpenedPushes.use(seen, "id5"));
        assertNotNull(OpenedPushes.use(seen, "id4"));
    }
}
