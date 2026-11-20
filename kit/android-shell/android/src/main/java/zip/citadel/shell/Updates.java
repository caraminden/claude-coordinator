package zip.citadel.shell;

import java.net.URI;
import org.json.JSONObject;

/**
 * The update prompt's rules, kept free of Android so the JVM tests run them (#1138). The feed is the one Citadel
 * publishes after each build (src/apk-build.ts), android/latest.json beside the app's page:
 * {@code { "versionCode": N, "apk": "<file>", "versionName"?: "1.2", "commit"?: "<sha>" }}, the apk relative to the feed.
 */
public final class Updates {

    /** A resume checks again only after this long, so switching apps doesn't refetch the feed each time. */
    public static final long RECHECK_MS = 30 * 60 * 1000L;

    private Updates() {}

    /** A newer build on the feed. */
    public static final class Offer {
        public final long versionCode;
        public final String versionName;
        public final String url;

        Offer(long versionCode, String versionName, String url) {
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.url = url;
        }
    }

    /** The feed's address: {@code configured} (absolute, or relative to the page) or android/latest.json beside it. */
    public static String feedUrl(String serverUrl, String configured) {
        String feed = configured == null || configured.isEmpty() ? "android/latest.json" : configured;
        try {
            URI f = new URI(feed);
            if (f.isAbsolute()) return feed;
            if (serverUrl == null) return null;
            String base = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
            return new URI(base).resolve(f).toString();
        } catch (Exception e) {
            return null;
        }
    }

    /** The feed's build, or null when the feed is malformed. */
    public static Offer parse(String json, String feedUrl) {
        try {
            JSONObject o = new JSONObject(json);
            Object code = o.opt("versionCode");
            Object apk = o.opt("apk");
            if (!(code instanceof Integer || code instanceof Long) || !(apk instanceof String) || ((String) apk).isEmpty()) return null;
            Object name = o.opt("versionName");
            String url = new URI(feedUrl).resolve((String) apk).toString();
            return new Offer(((Number) code).longValue(), name instanceof String ? (String) name : null, url);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Whether to ask: the feed's build is newer than the installed one, and the person hasn't said Later to it or a
     * newer one. Later holds per version, so the next build asks again.
     */
    public static boolean ask(Offer offer, long installed, long laterFor) {
        return offer != null && offer.versionCode > installed && offer.versionCode > laterFor;
    }

    /** Whether a resume should check again, {@link #RECHECK_MS} after the last check. */
    public static boolean due(long now, long lastCheck) {
        return lastCheck <= 0 || now - lastCheck >= RECHECK_MS || now < lastCheck;
    }

    /** The prompt's words. */
    public static String message(Offer offer) {
        String which = offer.versionName != null ? "Version " + offer.versionName + " (build " + offer.versionCode + ")" : "Build " + offer.versionCode;
        return which + " is ready. It downloads in your browser; open it to install over this one.";
    }
}
