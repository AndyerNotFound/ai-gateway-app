# Gson：反射读取的模型与泛型信息
-keepattributes Signature,*Annotation*,InnerClasses,EnclosingMethod
-keep class com.aigateway.app.data.** { *; }
-keepclassmembers,allowobfuscation class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken
-dontwarn sun.misc.**

# OkHttp / Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-keepclassmembers class okhttp3.internal.** { *; }

# ZXing
-keep class com.google.zxing.** { *; }
-dontwarn com.google.zxing.**

# Kotlin 协程
-dontwarn kotlinx.coroutines.**
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }

# 原生桥接
-keepclasseswithmembernames class com.aigateway.app.embedded.NodeBridge { native <methods>; }

# 设置项枚举按名称持久化
-keepclassmembers enum com.aigateway.app.data.** { *; }
