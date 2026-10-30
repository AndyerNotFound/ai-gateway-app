cmake_minimum_required(VERSION 3.22.1)
project(agwnode CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
        IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/../../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(agwnode SHARED native-lib.cpp)

target_include_directories(agwnode PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include/node")

target_compile_options(agwnode PRIVATE -fexceptions -frtti -Wall -Wextra -Wno-unused-parameter)

find_library(log-lib log)
target_link_libraries(agwnode node ${log-lib} android)
