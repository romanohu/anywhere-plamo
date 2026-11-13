plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.plamo.ocr"
    compileSdk = 36
    defaultConfig {
        minSdk = 28
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8 } }

dependencies {
    implementation(project(":tauri-android"))
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.23.2")
    implementation("org.opencv:opencv:4.11.0")
}
