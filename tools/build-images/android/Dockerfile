# citadel-build-android (H1, specs/heavy-jobs-across-machines.md section 3): what a heavy Android build needs on a
# lent machine. JDK 21 and Node through mise (a scheme's own mise.toml still wins inside), the SDK packages
# tools/android/install-sdk.sh pins (keep the two lists the same), and Gradle for projects with no wrapper and the
# self-test. Built and pushed by .github/workflows/build-images.yml; machines pull it by the digest in ../images.json.
FROM docker.io/library/ubuntu:24.04

ARG CMDLINE_ZIP=commandlinetools-linux-16111833_latest.zip
ARG CMDLINE_SHA1=e025545c62a8e64c7559119566a569fb1dec5f60
ARG GRADLE=8.14.3
ARG GRADLE_SHA256=bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/opt/mise/config \
    MISE_YES=1 \
    GRADLE_USER_HOME=/cache/gradle \
    npm_config_cache=/cache/npm
RUN apt-get update -q \
 && apt-get install -y -q --no-install-recommends ca-certificates curl git unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
 && mise use -g java@temurin-21 node@24 \
 && ln -s "$(mise where java@temurin-21)" /opt/java \
 && ln -s "$(mise where node@24)" /opt/node
ENV JAVA_HOME=/opt/java \
    PATH=/opt/java/bin:/opt/node/bin:/opt/gradle/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/mise/shims:$PATH

RUN curl -fsSL -o /tmp/cmdline.zip "https://dl.google.com/android/repository/$CMDLINE_ZIP" \
 && echo "$CMDLINE_SHA1  /tmp/cmdline.zip" | sha1sum -c - \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && unzip -q /tmp/cmdline.zip -d "$ANDROID_HOME/cmdline-tools" \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
 && rm /tmp/cmdline.zip \
 && yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install 'platform-tools' 'build-tools;36.1.0' 'build-tools;35.0.0' 'platforms;android-36' >/dev/null \
 && curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-$GRADLE-bin.zip" \
 && echo "$GRADLE_SHA256  /tmp/gradle.zip" | sha256sum -c - \
 && unzip -q /tmp/gradle.zip -d /opt \
 && mv "/opt/gradle-$GRADLE" /opt/gradle \
 && rm /tmp/gradle.zip \
 && chmod -R a+rX "$ANDROID_HOME" /opt/mise /opt/gradle

# The self-test (Set up's last step): a hello-world APK, built with the cache volume citadel-gradle at /cache/gradle.
COPY hello-apk /opt/citadel/hello-apk
COPY android/citadel-hello-apk /usr/local/bin/citadel-hello-apk
RUN chmod 755 /usr/local/bin/citadel-hello-apk
LABEL org.opencontainers.image.source=https://github.com/caraminden/claude-coordinator \
      org.opencontainers.image.description="Citadel's Android build image: JDK 21, Node 24, Android SDK 36 and build-tools 36.1.0 and 35.0.0, Gradle 8.14.3"
WORKDIR /work
