plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// google-services.json comes from the owner's Firebase project and is never committed (see ../README.md). Without it
// the app builds and its tests run, but it can't receive alerts; a release build refuses to build.
val googleServices = file("google-services.json")
if (googleServices.exists()) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "sh.unstuck.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "sh.unstuck.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    flavorDimensions += "server"
    productFlavors {
        create("prod") {
            dimension = "server"
            buildConfigField("String", "API_ORIGIN", "\"https://unstuck.sh\"")
            buildConfigField("String", "VIEW_ORIGIN", "\"https://view.unstuck.sh\"")
        }
        create("staging") {
            dimension = "server"
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            buildConfigField("String", "API_ORIGIN", "\"https://unstuck-cloud-staging.zeandcode.workers.dev\"")
            buildConfigField("String", "VIEW_ORIGIN", "\"https://unstuck-viewer-staging.zeandcode.workers.dev\"")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}

tasks.configureEach {
    if (name.startsWith("assemble") && name.endsWith("Release") && !project.hasProperty("unsignedRelease")) {
        doFirst {
            if (!googleServices.exists()) throw GradleException("google-services.json missing: see apps/android/README.md")
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("androidx.test:core:1.6.1")
}
