package zip.citadel.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;
import zip.citadel.shell.PushOwner.Step;

/** #1941: push follows the person signed in, and a turn-off Citadel never heard of is sent again. */
public class PushOwnerTest {

    private static final String A = PushOwner.login("theme=dark; cc_app=a.sig");
    private static final String B = PushOwner.login("cc_app=b.sig; theme=dark");

    @Test
    public void theSamePersonIsLeftAlone() {
        assertEquals(Step.NONE, PushOwner.next(true, true, A, A, false));
    }

    @Test
    public void someoneElseSigningInTakesThePhone() {
        assertEquals(Step.REGISTER, PushOwner.next(true, true, B, A, false));
        assertEquals(Step.REGISTER, PushOwner.next(true, false, B, null, false));
    }

    @Test
    public void signingOutEndsTheOldPersonsPush() {
        assertEquals(Step.UNREGISTER, PushOwner.next(true, true, null, A, false));
        // The cookie is still there but its session is over: Citadel asked them to sign in.
        assertEquals(Step.UNREGISTER, PushOwner.next(true, true, A, A, true));
        assertEquals(Step.NONE, PushOwner.next(true, false, A, null, true));
    }

    @Test
    public void aTurnOffThatDidNotReachCitadelIsSentAgain() {
        assertEquals(Step.UNREGISTER, PushOwner.next(false, true, A, A, false));
        assertEquals(Step.UNREGISTER, PushOwner.next(false, true, null, A, false));
        assertEquals(Step.NONE, PushOwner.next(false, false, A, null, false));
    }

    @Test
    public void aLoginIsCitadelsCookiesAlone() {
        assertEquals(A, PushOwner.login("cc_app=a.sig"));
        assertEquals(PushOwner.login("cc_app=a; cc_session=s"), PushOwner.login("cc_session=s; x=1; cc_app=a"));
        assertNotEquals(A, B);
        assertNull(PushOwner.login(null));
        assertNull(PushOwner.login("theme=dark; not_cc_app=a"));
        assertNull(PushOwner.login("cc_app="));
    }
}
