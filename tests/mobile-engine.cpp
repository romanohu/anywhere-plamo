#include "../src-tauri/src/translation.cpp"
#include <cassert>
#include <iostream>

struct Output { std::string text; bool cancel = false; };
static bool is_cancelled(void * data) { return static_cast<Output *>(data)->cancel; }
static bool collect(const char * bytes, size_t length, void * data) {
    auto output = static_cast<Output *>(data);
    output->text.append(bytes, length);
    return !output->cancel;
}
static bool stop_first(const char * bytes, size_t length, void * data) {
    collect(bytes, length, data);
    static_cast<Output *>(data)->cancel = true;
    return false;
}

int main(int argc, char ** argv) {
    assert(argc == 2);
    Output output;
    void * model = plamo_load(argv[1], is_cancelled, &output);
    assert(model);
    const std::string prompt = "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>Hello, world.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>";
    assert(plamo_tokens(model, prompt.data(), prompt.size()) > 0);
    assert(plamo_translate(model, prompt.data(), prompt.size(), collect, is_cancelled, &output) == 0);
    assert(!output.text.empty() && output.text.find("<|plamo:") == std::string::npos);
    const auto expected = output.text;
    std::cout << "translation: " << expected << '\n';
    output = {};
    assert(plamo_translate(model, prompt.data(), prompt.size(), stop_first, is_cancelled, &output) == 2);
    output = {};
    assert(plamo_translate(model, prompt.data(), prompt.size(), collect, is_cancelled, &output) == 0);
    assert(output.text == expected);
    plamo_free(model);
    output.cancel = true;
    assert(!plamo_load(argv[1], is_cancelled, &output));
    std::cout << "PASS translation, cancellation, reuse, and cancelled loading\n";
}
