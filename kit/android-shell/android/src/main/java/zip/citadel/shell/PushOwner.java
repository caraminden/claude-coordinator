package zip.citadel.shell;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.TreeSet;

/**
 * Whose push this phone should get: the person signed in to the app, and nobody once they sign out or turn push off.
 * Checked as each page loads, so a login change, or a turn-off Citadel couldn't be told of, is put right then.
 *
 * Plain Java so the JVM tests run it.
 */
final class PushOwner {

    enum Step {
        NONE,
        /** Tell Citadel this phone is the signed-in person's: nobody's yet, or someone else's. */
        REGISTER,
        /** Tell Citadel to forget this phone. */
        UNREGISTER,
    }

    private PushOwner() {}

    /**
     * @param enabled      push is on in the app
     * @param registered   Citadel has a token for this phone
     * @param login        who the WebView is signed in as ({@link #login}), or null
     * @param registeredAs the login Citadel last took the token from, or null
     * @param signInPage   the page shown is Citadel's sign-in, so the login the WebView may still hold is over
     */
    static Step next(boolean enabled, boolean registered, String login, String registeredAs, boolean signInPage) {
        if (!enabled || login == null || signInPage) return registered ? Step.UNREGISTER : Step.NONE;
        return registered && login.equals(registeredAs) ? Step.NONE : Step.REGISTER;
    }

    /**
     * A mark that changes when the login does, from the WebView's Cookie header: a hash of Citadel's cookies (the app
     * host's cc_app, Citadel's own cc_session), or null when there are none. A renewed cookie reads as a new login, which
     * only registers the same person again.
     */
    static String login(String cookies) {
        if (cookies == null) return null;
        TreeSet<String> own = new TreeSet<>();
        for (String c : cookies.split(";")) {
            String s = c.trim();
            if ((s.startsWith("cc_app=") || s.startsWith("cc_session=")) && !s.endsWith("=")) own.add(s);
        }
        if (own.isEmpty()) return null;
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(String.join(";", own).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : d) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
