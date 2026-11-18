pluginManagement {
    repositories {
        google()
        // Google's Maven Central mirror first: Maven Central's edge sometimes answers 404 to a HEAD for files it has,
        // and Gradle then caches the file as missing.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Google's Maven Central mirror first: Maven Central's edge sometimes answers 404 to a HEAD for files it has,
        // and Gradle then caches the file as missing.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}
rootProject.name = "unstuck-android"
include(":app")
