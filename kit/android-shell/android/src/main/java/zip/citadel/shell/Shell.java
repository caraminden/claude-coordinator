package zip.citadel.shell;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;
import com.getcapacitor.CapConfig;
import com.getcapacitor.PluginConfig;

/** What the shell's parts share: its settings, the app's address from capacitor.config.json, and the WebView's cookies. */
final class Shell {

    static final String PLUGIN = "CitadelShell";

    private Shell() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences("citadel_shell", Context.MODE_PRIVATE);
    }

    static CapConfig config(Context context) {
        return CapConfig.loadDefault(context.getApplicationContext());
    }

    static PluginConfig pluginConfig(Context context) {
        return config(context).getPluginConfiguration(PLUGIN);
    }

    /** The app's server.url (https://voice.citadel.zip/apps/voice/), or null for an app that bundles its pages. */
    static String serverUrl(Context context) {
        return config(context).getServerUrl();
    }

    /** The WebView's cookies for {@code url}, sent with the shell's own requests so Citadel knows the person. */
    static String cookies(String url) {
        try {
            return CookieManager.getInstance().getCookie(url);
        } catch (RuntimeException e) {
            // No WebView on this device or process: the request goes without.
            return null;
        }
    }
}
