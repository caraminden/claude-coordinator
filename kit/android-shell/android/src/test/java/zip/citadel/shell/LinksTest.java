package zip.citadel.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Which Citadel pages stay in the app's WebView (sign-in) and which open outside it (Mandate #127, shared by #1138), for an app at /apps/mandate. */
public class LinksTest {

    private static final String APP = "mandate.citadel.example";
    private static final String CITADEL = "citadel.example";

    private static String out(String url) {
        return Links.outside(url, APP, CITADEL, "/apps/mandate");
    }

    @Test
    public void mandatesOwnPagesStay() {
        assertNull(out("https://mandate.citadel.example/apps/mandate/"));
        assertNull(out("https://mandate.citadel.example/apps/mandate/?item=3#x"));
        assertNull(out("https://mandate.citadel.example/apps/mandate"));
        assertNull(out("https://mandate.citadel.example/"));
        assertNull(out("https://mandate.citadel.example/_citadel/enter?t=abc&next=%2Fapps%2Fmandate%2F"));
        assertNull(out("https://mandate.citadel.example/_citadel/entered?next=%2Fapps%2Fmandate%2F"));
    }

    @Test
    public void signInStaysEveryStepOfTheWay() {
        // Mandate's own "Sign in" button (web/main.tsx), then Citadel's redirects (src/apps.ts).
        assertNull(out("https://mandate.citadel.example/c/?next=%2Fapps%2Fmandate%2F"));
        assertNull(out("https://citadel.example/c/?next=%2Fapps%2Fmandate%2F"));
        assertNull(out("https://citadel.example/c/?next=/apps/mandate/%3Fitem%3D3"));
        assertNull(out("https://citadel.example/c?next=%2Fapps%2Fmandate%2F"));
        assertNull(out("https://citadel.example/apps/mandate/"));
        assertNull(out("https://citadel.example/apps/mandate/?item=3"));
        assertNull(out("https://citadel.example/api/me"));
    }

    @Test
    public void citadelsSignInForTheAppIsKnown() {
        assertTrue(Links.isSignIn("https://citadel.example/c/?next=%2Fapps%2Fmandate%2F", CITADEL, "/apps/mandate"));
        assertFalse(Links.isSignIn("https://citadel.example/c/?next=%2Fapps%2Fvoice%2F", CITADEL, "/apps/mandate"));
        assertFalse(Links.isSignIn("https://citadel.example/c/", CITADEL, "/apps/mandate"));
        assertFalse(Links.isSignIn("https://mandate.citadel.example/apps/mandate/", CITADEL, "/apps/mandate"));
        assertFalse(Links.isSignIn(null, CITADEL, "/apps/mandate"));
        assertFalse(Links.isSignIn("https://citadel.example/c/?next=%2Fapps%2Fmandate%2F", null, null));
    }

    @Test
    public void citadelsOtherPagesOpenOutside() {
        assertEquals("https://citadel.example/c/#/p/3", out("https://citadel.example/c/#/p/3"));
        assertEquals("https://citadel.example/c/", out("https://citadel.example/c/"));
        assertEquals("https://citadel.example/", out("https://citadel.example/"));
        assertEquals("https://citadel.example/apps/other/", out("https://citadel.example/apps/other/"));
        // Not a sign-in back to Mandate: next names another page, or Mandate's name is only a prefix.
        assertEquals("https://citadel.example/c/?next=%2Fapps%2Fother%2F", out("https://citadel.example/c/?next=%2Fapps%2Fother%2F"));
        assertEquals("https://citadel.example/apps/mandatex/", out("https://citadel.example/apps/mandatex/"));
    }

    @Test
    public void aCitadelLinkOnMandatesHostGoesStraightToCitadelKeepingItsHash() {
        // A relative /c/#/p/3 (a note, the Acolyte's reply, an item's "Open in Citadel") resolves on Mandate's host.
        assertEquals("https://citadel.example/c/#/p/3/t/12", out("https://mandate.citadel.example/c/#/p/3/t/12"));
        assertEquals("https://citadel.example/c/?x=1#/p/3", out("https://mandate.citadel.example/c/?x=1#/p/3"));
        assertEquals("https://citadel.example/apps/other/", out("https://mandate.citadel.example/apps/other/"));
    }

    @Test
    public void otherHostsAndSchemesAreLeftToCapacitor() {
        assertNull(out("https://example.com/c/#/p/3"));
        assertNull(out("https://other.citadel.example/apps/other/"));
        assertNull(out("mailto:someone@example.com"));
        assertNull(out("tel:5550100"));
        assertNull(out("not a url"));
        assertNull(Links.outside("https://citadel.example/c/", APP, null, "/apps/mandate"));
        assertNull(Links.outside("https://citadel.example/c/", APP, CITADEL, null));
    }

    @Test
    public void theAppsPathComesFromItsServerUrl() {
        assertEquals("/apps/voice", Links.selfPath("https://voice.citadel.zip/apps/voice/"));
        assertEquals("/apps/voice", Links.selfPath("https://voice.citadel.zip/apps/voice"));
        assertEquals("/apps/voice", Links.selfPath("https://voice.citadel.zip/apps/voice/index.html?x=1"));
        assertEquals("voice", Links.appName("https://voice.citadel.zip/apps/voice/"));
        assertNull(Links.selfPath("https://voice.citadel.zip/"));
        assertNull(Links.selfPath("https://voice.citadel.zip/apps/"));
        assertNull(Links.selfPath("https://localhost/"));
        assertNull(Links.selfPath(null));
        assertNull(Links.appName("not a url at all ::"));
    }

    @Test
    public void citadelsHostIsTheAppsWithoutItsFirstLabelUnlessSet() {
        assertEquals("citadel.zip", Links.citadelHost("voice.citadel.zip", null));
        assertEquals("citadel.zip", Links.citadelHost("voice.citadel.zip", ""));
        assertEquals("citadel.example", Links.citadelHost("voice.citadel.zip", "citadel.example"));
        assertNull(Links.citadelHost("localhost", null));
        assertNull(Links.citadelHost(null, null));
    }

    @Test
    public void anotherAppsPathIsntThisOnes() {
        // The same rules for Voice: Mandate's pages are another app's, so they leave Voice's window.
        assertEquals("https://citadel.example/apps/mandate/", Links.outside("https://citadel.example/apps/mandate/", "voice.citadel.example", CITADEL, "/apps/voice"));
        assertNull(Links.outside("https://citadel.example/c/?next=%2Fapps%2Fvoice%2F", "voice.citadel.example", CITADEL, "/apps/voice"));
    }

    @Test
    public void originKeepsSchemeHostAndPort() {
        assertEquals("https://voice.citadel.zip", Links.origin("https://voice.citadel.zip/apps/voice/"));
        assertEquals("http://10.0.2.2:8080", Links.origin("http://10.0.2.2:8080/apps/voice/"));
        assertNull(Links.origin("voice"));
        assertNull(Links.origin(null));
    }
}
