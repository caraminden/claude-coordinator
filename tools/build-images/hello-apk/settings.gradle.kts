// The Builds role's self-test app (tools/build-images/android/citadel-hello-apk): a manifest and nothing else.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "citadel-hello"
