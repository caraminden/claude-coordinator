package zip.citadel.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** Reading a push from Citadel's FCM data (#1138): what shows, what a tap opens, what the app's handler gets. */
public class PushMessageTest {

    private static final String ORIGIN = "https://voice.citadel.zip";
    private static final String SELF = "/apps/voice";

    private static Map<String, String> data(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    @Test
    public void aTitledPushNotifiesAndOpensItsPage() {
        PushMessage p = PushMessage.from(data("citadel_title", "Report ready", "citadel_body", "Tuesday's take", "citadel_open", "/apps/voice/#/takes/12", "citadel_tag", "take-12", "citadel_app", "voice"), ORIGIN, SELF);
        assertTrue(p.notifies());
        assertEquals("Report ready", p.title);
        assertEquals("Tuesday's take", p.body);
        assertEquals("take-12", p.tag);
        assertEquals("https://voice.citadel.zip/apps/voice/#/takes/12", p.open);
        assertTrue(p.appData.isEmpty());
    }

    @Test
    public void dataAloneGoesOnlyToTheApp() {
        PushMessage p = PushMessage.from(data("citadel_app", "voice", "kind", "sync", "since", "42"), ORIGIN, SELF);
        assertFalse(p.notifies());
        assertEquals(2, p.appData.size());
        assertEquals("sync", p.appData.get("kind"));
        assertFalse(p.appData.containsKey("citadel_app"));
        assertNull(PushMessage.from(data("citadel_title", ""), ORIGIN, SELF).title);
    }

    /** The server's rule and this one, over one list of cases (test/fcm.test.ts reads it too). */
    @Test
    public void theOpenRuleAgreesWithTheServerCaseByCase() throws Exception {
        String home = ORIGIN + SELF + "/";
        int cases = 0;
        try (BufferedReader in = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/push-open-cases.txt"), StandardCharsets.UTF_8))) {
            for (String line; (line = in.readLine()) != null; ) {
                if (line.isEmpty() || line.startsWith("#")) continue;
                String open = line.substring(3).replace("<TAB>", "\t");
                assertEquals(line, line.startsWith("ok ") ? ORIGIN + open : home, PushMessage.open(open, ORIGIN, SELF));
                cases++;
            }
        }
        assertTrue(cases + " cases", cases > 20);
    }

    @Test
    public void aTapNeverLeavesTheAppsOwnPages() {
        String home = "https://voice.citadel.zip/apps/voice/";
        assertEquals(home, PushMessage.open(null, ORIGIN, SELF));
        assertEquals(home, PushMessage.open("/apps/mandate/", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("/apps/voicex/", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("https://evil.example/apps/voice/", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("//evil.example/apps/voice/", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("/apps/voice//evil.example", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("/apps/voice/../../c/", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("/apps/voice/..", ORIGIN, SELF));
        assertEquals(home, PushMessage.open("/apps/voice/%2E%2e/%2e%2E/c/", ORIGIN, SELF));
        assertEquals("https://voice.citadel.zip/apps/voice/takes?id=3", PushMessage.open("/apps/voice/takes?id=3", ORIGIN, SELF));
        // An app with no known address can't open anything; the tap just brings it up.
        assertNull(PushMessage.open("/apps/voice/", null, SELF));
        assertNull(PushMessage.open("/apps/voice/", ORIGIN, null));
    }
}
