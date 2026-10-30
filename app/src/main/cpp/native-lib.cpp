#include <jni.h>
#include <node.h>
#include <android/log.h>
#include <unistd.h>

#include <string>
#include <vector>

#define LOG_TAG "agw-node"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// node::Start never returns until the runtime shuts down, and Node keeps the argv pointers for
// its whole lifetime, so both buffers must outlive the call.
std::vector<std::string> g_args;
std::vector<char*> g_argv;

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_aigateway_app_embedded_NodeBridge_nativeStart(JNIEnv* env, jclass, jobjectArray jsArgs) {
    if (jsArgs == nullptr) {
        LOGE("nativeStart: null argv");
        return -1;
    }
    const jsize count = env->GetArrayLength(jsArgs);
    g_args.clear();
    g_argv.clear();
    g_args.reserve(static_cast<size_t>(count) + 1);
    for (jsize i = 0; i < count; ++i) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(jsArgs, i));
        if (item == nullptr) {
            g_args.emplace_back();
            continue;
        }
        const char* chars = env->GetStringUTFChars(item, nullptr);
        g_args.emplace_back(chars == nullptr ? "" : chars);
        if (chars != nullptr) env->ReleaseStringUTFChars(item, chars);
        env->DeleteLocalRef(item);
    }
    for (auto& s : g_args) g_argv.push_back(const_cast<char*>(s.c_str()));
    g_argv.push_back(nullptr);

    LOGI("starting node: %s", g_args.size() > 1 ? g_args[1].c_str() : "(no script)");
    const int rc = node::Start(static_cast<int>(g_args.size()), g_argv.data());
    LOGI("node exited with %d", rc);
    return rc;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_aigateway_app_embedded_NodeBridge_nativePageSize(JNIEnv*, jclass) {
    return static_cast<jint>(getpagesize());
}
