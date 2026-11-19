plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.direkiwi.potfit"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.direkiwi.potfit"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
