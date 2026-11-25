package zip.citadel.shell;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Which notifications' taps have already opened their page. Android hands an app its task's first intent again, extras
 * included, when it is reopened from Recents or after its process died, so each push carries an id of its own and opens
 * its page once. The ids kept are a list in the shell's prefs: the one Android redelivers may be older than the last tap.
 *
 * Plain Java so the JVM tests run it.
 */
final class OpenedPushes {

    /** Far more taps than one task sees before a launcher start replaces its first intent. */
    static final int KEPT = 200;

    private OpenedPushes() {}

    /** {@code seen} with {@code id} added, or null when it is already there (or is no id): the tap was used. */
    static String use(String seen, String id) {
        if (id == null || id.isEmpty()) return null;
        List<String> ids = new ArrayList<>(Arrays.asList(seen == null || seen.isEmpty() ? new String[0] : seen.split(",")));
        if (ids.contains(id)) return null;
        ids.add(id);
        return String.join(",", ids.subList(Math.max(0, ids.size() - KEPT), ids.size()));
    }
}
