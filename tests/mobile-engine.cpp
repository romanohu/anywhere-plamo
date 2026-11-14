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
static bool has_script(const std::string & text, unsigned low, unsigned high) {
    for (size_t i = 0; i + 2 < text.size(); ++i) {
        const auto first = static_cast<unsigned char>(text[i]);
        if ((first & 0xf0) != 0xe0) continue;
        const unsigned point = ((first & 15) << 12) |
            ((static_cast<unsigned char>(text[i + 1]) & 63) << 6) |
            (static_cast<unsigned char>(text[i + 2]) & 63);
        if (point >= low && point <= high) return true;
    }
    return false;
}

int main(int argc, char ** argv) {
    assert(argc == 2);
    Output output;
    void * model = plamo_load(argv[1], is_cancelled, &output);
    assert(model);
    const std::string prompt = "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>Please close the door.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>";
    assert(plamo_tokens(model, prompt.data(), prompt.size()) > 0);
    assert(plamo_translate(model, prompt.data(), prompt.size(), collect, is_cancelled, &output) == 0);
    assert(!output.text.empty() && output.text.find("<|plamo:") == std::string::npos);
    const auto expected = output.text;
    std::cout << "translation: " << expected << '\n';
    auto engine = static_cast<Translator *>(model);
    assert(!engine->prompt.empty());
    output = {};
    assert(plamo_translate(model, prompt.data(), prompt.size(), collect, is_cancelled, &output) == 0);
    assert(output.text == expected);

    // Reusing the source prefix must still evaluate the new language and changed words.
    for (const auto & changed : {
        std::string("<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>Please close the door.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ko<|plamo:msg|>"),
        std::string("<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>Please open the door.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>")
    }) {
        output = {};
        assert(plamo_translate(model, changed.data(), changed.size(), collect, is_cancelled, &output) == 0);
        const auto reused = output.text;
        assert(!reused.empty() && reused != expected);
        const bool korean = changed.find("<|plamo:val|>ko") != std::string::npos;
        assert(has_script(reused, korean ? 0xac00 : 0x3040, korean ? 0xd7a3 : 0x30ff));
        engine->prompt.clear();
        llama_memory_clear(llama_get_memory(engine->context), false);
        output = {};
        assert(plamo_translate(model, changed.data(), changed.size(), collect, is_cancelled, &output) == 0);
        // Batch sizes can change floating-point tie breaks, so wording need not be identical.
        assert(!output.text.empty() && output.text != expected);
        assert(has_script(output.text, korean ? 0xac00 : 0x3040, korean ? 0xd7a3 : 0x30ff));
    }
    output = {};
    assert(plamo_translate(model, prompt.data(), prompt.size(), stop_first, is_cancelled, &output) == 2);
    assert(engine->prompt.empty());
    assert(llama_memory_seq_pos_min(llama_get_memory(engine->context), 0) == -1);
    output = {};
    assert(plamo_translate(model, prompt.data(), prompt.size(), collect, is_cancelled, &output) == 0);
    assert(output.text == expected);
    // Force the sliding window past the saved prefix. The next request must start fresh.
    std::vector<llama_token> continuation(512, engine->prompt.back());
    const auto memory = llama_get_memory(engine->context);
    for (int i = 0; i < 6; ++i) {
        auto batch = llama_batch_get_one(continuation.data(), continuation.size());
        assert(llama_decode(engine->context, batch) == 0);
    }
    assert(llama_memory_seq_pos_min(memory, 0) > 0);
    output = {};
    assert(plamo_translate(model, prompt.data(), prompt.size(), collect, is_cancelled, &output) == 0);
    assert(output.text == expected);
    plamo_free(model);
    output.cancel = true;
    assert(!plamo_load(argv[1], is_cancelled, &output));
    std::cout << "PASS translation, prefix/language reuse, sliding-window recovery, cancellation, and cancelled loading\n";
}
