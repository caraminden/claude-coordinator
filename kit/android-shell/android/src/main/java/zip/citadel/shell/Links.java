package zip.citadel.shell;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/**
 * Which of Citadel's pages the app's WebView keeps (from Mandate #122 and #127, shared by #1138). Citadel's host is
 * allowed in the WebView only for sign-in: a signed-out app goes citadel.zip/c/?next=/apps/voice/ → (signs in) →
 * citadel.zip/apps/voice/ → voice.citadel.zip/_citadel/enter?t=… (Citadel's src/apps.ts). Every other Citadel page
 * (an "Open in Citadel", a /c/#/p/3 link, another contraption) opens outside the app, in Citadel's installed app or
 * the browser, so the app's window never ends up showing Citadel.
 *
 * Plain java.net.URI, so the JVM tests can run it without Android.
 */
public final class Links {

    private Links() {}

    /**
     * For a page the WebView is about to load: the address to open outside the app instead, or null to let the
     * WebView (or Capacitor, for any other host) handle it as before.
     *
     * @param url     the page being loaded
     * @param app     the app's own host (voice.citadel.zip)
     * @param citadel Citadel's host (citadel.zip), allowed in the WebView for sign-in
     * @param self    the app's path on both hosts ("/apps/voice"), from {@link #selfPath}
     */
    public static String outside(String url, String app, String citadel, String self) {
        if (url == null || app == null || citadel == null || self == null) return null;
        URI u;
        try {
            u = new URI(url);
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = u.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return null;
        String host = u.getHost();
        String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        if (app.equalsIgnoreCase(host)) {
            if (path.equals("/") || under(path, self) || under(path, "/_citadel") || under(path, "/apps/_citadel") || signIn(path, u.getRawQuery(), self)) return null;
            // The app's host sends Citadel's pages (a relative /c/#/p/3) on to Citadel's: go there directly, which
            // also keeps the # part a redirect could drop.
            if (under(path, "/c") || under(path, "/apps") || under(path, "/api")) return rehost(u, citadel);
            return null;
        }
        if (citadel.equalsIgnoreCase(host)) {
            if (under(path, self) || under(path, "/api") || signIn(path, u.getRawQuery(), self)) return null;
            return url;
        }
        return null;
    }

    /** The app's own path from its server.url: https://voice.citadel.zip/apps/voice/ → "/apps/voice"; null when it isn't one. */
    public static String selfPath(String serverUrl) {
        String path = pathOf(serverUrl);
        if (path == null || !path.startsWith("/apps/")) return null;
        int end = path.indexOf('/', "/apps/".length());
        String self = end < 0 ? path : path.substring(0, end);
        return self.length() > "/apps/".length() ? self : null;
    }

    /** The app's name from its server.url ("voice"), or null. */
    public static String appName(String serverUrl) {
        String self = selfPath(serverUrl);
        return self == null ? null : self.substring("/apps/".length());
    }

    /**
     * Citadel's host: {@code configured} when the app sets plugins.CitadelShell.citadelHost, else the app's host
     * without its first label (voice.citadel.zip → citadel.zip).
     */
    public static String citadelHost(String appHost, String configured) {
        if (configured != null && !configured.isEmpty()) return configured;
        if (appHost == null) return null;
        int dot = appHost.indexOf('.');
        return dot < 0 || dot == appHost.length() - 1 ? null : appHost.substring(dot + 1);
    }

    /** "https://voice.citadel.zip" from any address on it, or null. */
    public static String origin(String url) {
        try {
            URI u = new URI(url);
            if (u.getScheme() == null || u.getRawAuthority() == null) return null;
            return u.getScheme() + "://" + u.getRawAuthority();
        } catch (URISyntaxException | NullPointerException e) {
            return null;
        }
    }

    private static String pathOf(String url) {
        if (url == null) return null;
        try {
            return new URI(url).getRawPath();
        } catch (URISyntaxException e) {
            return null;
        }
    }

    /** Citadel's sign-in page on its way back to the app: /c/?next=/apps/voice/…. */
    private static boolean signIn(String path, String query, String self) {
        if (!path.equals("/c/") && !path.equals("/c")) return false;
        String next = param(query, "next");
        return next != null && under(next, self);
    }

    static boolean under(String path, String dir) {
        return path.equals(dir) || path.startsWith(dir + "/");
    }

    private static String param(String query, String name) {
        if (query == null) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            if (!key.equals(name)) continue;
            try {
                return URLDecoder.decode(eq < 0 ? "" : pair.substring(eq + 1), StandardCharsets.UTF_8.name());
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    private static String rehost(URI u, String host) {
        StringBuilder out = new StringBuilder("https://").append(host).append(u.getRawPath());
        if (u.getRawQuery() != null) out.append('?').append(u.getRawQuery());
        if (u.getRawFragment() != null) out.append('#').append(u.getRawFragment());
        return out.toString();
    }
}
