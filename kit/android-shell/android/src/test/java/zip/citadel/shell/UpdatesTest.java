package zip.citadel.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The native update prompt's rules (#1138): which feed, what it offers, and when it asks. */
public class UpdatesTest {

    private static final String FEED = "https://voice.citadel.zip/apps/voice/android/latest.json";

    @Test
    public void theFeedSitsBesideThePageUnlessSet() {
        assertEquals(FEED, Updates.feedUrl("https://voice.citadel.zip/apps/voice/", null));
        assertEquals(FEED, Updates.feedUrl("https://voice.citadel.zip/apps/voice", ""));
        assertEquals("https://voice.citadel.zip/apps/voice/test/feed.json", Updates.feedUrl("https://voice.citadel.zip/apps/voice/", "test/feed.json"));
        assertEquals("http://localhost:8123/latest.json", Updates.feedUrl("https://voice.citadel.zip/apps/voice/", "http://localhost:8123/latest.json"));
        assertEquals("http://localhost:8123/latest.json", Updates.feedUrl(null, "http://localhost:8123/latest.json"));
        // An app that bundles its pages has no address to find a relative feed beside.
        assertNull(Updates.feedUrl(null, null));
    }

    @Test
    public void theApkIsRelativeToTheFeed() {
        Updates.Offer o = Updates.parse("{\"versionCode\": 236, \"apk\": \"voice-236.apk\", \"versionName\": \"1.4\", \"commit\": \"abc\"}", FEED);
        assertEquals(236, o.versionCode);
        assertEquals("1.4", o.versionName);
        assertEquals("https://voice.citadel.zip/apps/voice/android/voice-236.apk", o.url);
        assertNull(Updates.parse("{\"versionCode\": 236, \"apk\": \"voice-236.apk\"}", FEED).versionName);
    }

    @Test
    public void aMalformedFeedOffersNothing() {
        assertNull(Updates.parse("{\"versionCode\": \"236\", \"apk\": \"voice-236.apk\"}", FEED));
        assertNull(Updates.parse("{\"versionCode\": 236.5, \"apk\": \"voice-236.apk\"}", FEED));
        assertNull(Updates.parse("{\"versionCode\": 236}", FEED));
        assertNull(Updates.parse("{\"versionCode\": 236, \"apk\": \"\"}", FEED));
        assertNull(Updates.parse("<html>sign in</html>", FEED));
        assertNull(Updates.parse("", FEED));
    }

    @Test
    public void asksOnlyForANewerBuildNotSaidLaterTo() {
        Updates.Offer o = Updates.parse("{\"versionCode\": 236, \"apk\": \"voice-236.apk\"}", FEED);
        assertTrue(Updates.ask(o, 235, 0));
        assertFalse(Updates.ask(o, 236, 0));
        assertFalse(Updates.ask(o, 300, 0));
        // Later holds for that build and older ones, and the next build asks again.
        assertFalse(Updates.ask(o, 235, 236));
        assertFalse(Updates.ask(o, 235, 240));
        assertTrue(Updates.ask(o, 235, 235));
        assertFalse(Updates.ask(null, 235, 0));
    }

    @Test
    public void aResumeChecksAgainAfterHalfAnHour() {
        long t = 1_000_000_000L;
        assertTrue(Updates.due(t, 0));
        assertFalse(Updates.due(t + Updates.RECHECK_MS - 1, t));
        assertTrue(Updates.due(t + Updates.RECHECK_MS, t));
        // The clock moved back (set by hand): check rather than wait it out.
        assertTrue(Updates.due(t - 1, t));
    }

    @Test
    public void thePromptNamesTheBuild() {
        assertTrue(Updates.message(Updates.parse("{\"versionCode\": 236, \"apk\": \"a.apk\", \"versionName\": \"1.4\"}", FEED)).startsWith("Version 1.4 (build 236) is ready."));
        assertTrue(Updates.message(Updates.parse("{\"versionCode\": 236, \"apk\": \"a.apk\"}", FEED)).startsWith("Build 236 is ready."));
    }
}
