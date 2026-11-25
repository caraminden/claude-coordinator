package zip.citadel.shell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import org.junit.Test;

/** #1941: the offline page is for an app that can't be reached, not for what Citadel has to say. */
public class GatewayTest {

    @Test
    public void aGatewayErrorIsUnreachable() {
        for (int status : new int[] { 502, 503, 504 }) assertTrue(Gateway.unreachable(status, Collections.emptyMap()));
        // Citadel's 502 for an app that is down carries no mark.
        assertTrue(Gateway.unreachable(502, Collections.singletonMap("Content-Type", "text/html")));
        assertTrue(Gateway.unreachable(503, null));
    }

    @Test
    public void citadelsOwnPageShows() {
        assertFalse(Gateway.unreachable(503, Collections.singletonMap("X-Citadel-Page", "1")));
        assertFalse(Gateway.unreachable(503, Collections.singletonMap("x-citadel-page", "1")));
    }

    @Test
    public void otherAnswersShowAsTheyAre() {
        for (int status : new int[] { 200, 403, 404, 500 }) assertFalse(Gateway.unreachable(status, null));
    }
}
