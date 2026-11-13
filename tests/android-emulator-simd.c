// Diagnose the PHADDD aliasing bug in the Android x86_64 software emulator.
// Build with x86_64-linux-android28-clang -O2 -mssse3, then run through adb.
#include <stdint.h>
#include <stdio.h>
#include <tmmintrin.h>

int main(void) {
    uint32_t values[4] = {1, 2, 3, 4};
    __m128i lanes = _mm_loadu_si128((const __m128i *)values);
    // Force the same source and destination register; constant folding or
    // separate operands would hide the emulator defect.
    __asm__ volatile("phaddd %0, %0" : "+x"(lanes));
    _mm_storeu_si128((__m128i *)values, lanes);
    printf("PHADDD: %u %u %u %u (expected 3 7 3 7)\n",
           values[0], values[1], values[2], values[3]);
    return values[0] != 3 || values[1] != 7 || values[2] != 3 || values[3] != 7;
}
