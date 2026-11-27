// The Android Gradle Plugin Capacitor 8 uses (kit/skills/android-app's pinned versions).
plugins {
    id("com.android.application") version "8.13.0"
}

android {
    namespace = "zip.citadel.hello"
    compileSdk = 36
    defaultConfig {
        applicationId = "zip.citadel.hello"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
}
