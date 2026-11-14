#include "llama.h"
#include <algorithm>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using Cancel = bool (*)(void *);
using Emit = bool (*)(const char *, size_t, void *);
struct Translator {
    llama_model * model = nullptr;
    llama_context * context = nullptr;
    std::vector<llama_token> prompt;
    ~Translator() { if (context) llama_free(context); if (model) llama_model_free(model); }
};
struct Request { Cancel cancel; void * data; };
static bool cancelled(void * data) { auto r = static_cast<Request *>(data); return r->cancel(r->data); }
static bool loading(float, void * data) { return !cancelled(data); }

extern "C" void * plamo_load(const char * path, Cancel cancel, void * data) {
    try {
        static std::once_flag initialized;
        std::call_once(initialized, [] {
            llama_log_set([](ggml_log_level, const char *, void *) {}, nullptr);
            llama_backend_init();
        });
        Request request{cancel, data};
        auto engine = std::make_unique<Translator>();
        auto model_params = llama_model_default_params();
        model_params.n_gpu_layers = 0;
        model_params.progress_callback = loading;
        model_params.progress_callback_user_data = &request;
        engine->model = llama_model_load_from_file(path, model_params);
        if (!engine->model || cancel(data)) return nullptr;
        auto params = llama_context_default_params();
        params.n_ctx = 8192;
        params.n_batch = 512;
        params.n_ubatch = 128;
        params.swa_full = false;
        params.n_threads = params.n_threads_batch = std::max(1u, std::min(4u, std::thread::hardware_concurrency()));
        engine->context = llama_init_from_model(engine->model, params);
        return engine->context && !cancel(data) ? engine.release() : nullptr;
    } catch (...) { return nullptr; }
}

extern "C" void plamo_free(void * handle) { delete static_cast<Translator *>(handle); }

extern "C" int plamo_tokens(void * handle, const char * prompt, int length) {
    auto engine = static_cast<Translator *>(handle);
    return -llama_tokenize(llama_model_get_vocab(engine->model), prompt, length, nullptr, 0, true, true);
}

// 0: complete, 1: output limit, 2: cancelled, 3: inference error.
extern "C" int plamo_translate(void * handle, const char * prompt, int length, Emit emit, Cancel cancel, void * data) {
    auto engine = static_cast<Translator *>(handle);
    Request request{cancel, data};
    llama_set_abort_callback(engine->context, cancelled, &request);
    struct Reset {
        Translator * engine;
        bool reusable = false;
        ~Reset() {
            llama_set_abort_callback(engine->context, nullptr, nullptr);
            if (!reusable) {
                engine->prompt.clear();
                llama_memory_clear(llama_get_memory(engine->context), false);
            }
        }
    } reset{engine};
    const auto finish = [&](int result) { reset.reusable = result < 2; return result; };
    try {
        const auto vocab = llama_model_get_vocab(engine->model);
        const int count = plamo_tokens(handle, prompt, length);
        if (count <= 0 || count > 4096) return 3;
        std::vector<llama_token> tokens(count);
        if (llama_tokenize(vocab, prompt, length, tokens.data(), count, true, true) != count) return 3;
        auto memory = llama_get_memory(engine->context);
        int reused = 0;
        // A sliding-window cache can have discarded the beginning after a long result.
        // Only reuse a complete prefix, and reevaluate the last token to obtain logits.
        if (llama_memory_seq_pos_min(memory, 0) == 0) {
            const int limit = std::min(count - 1, static_cast<int>(engine->prompt.size()));
            while (reused < limit && tokens[reused] == engine->prompt[reused]) ++reused;
        }
        if (!llama_memory_seq_rm(memory, 0, reused, -1)) {
            reused = 0;
            llama_memory_clear(memory, false);
        }
        for (int offset = reused; offset < count; offset += 512) {
            if (cancel(data)) return 2;
            auto batch = llama_batch_get_one(tokens.data() + offset, std::min(512, count - offset));
            if (llama_decode(engine->context, batch)) return cancel(data) ? 2 : 3;
        }
        engine->prompt = std::move(tokens);
        auto sampler = std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)>(llama_sampler_init_greedy(), llama_sampler_free);
        if (!sampler) return 3;
        std::string pending;
        const std::string stops[] = {"<|plamo:tag|>", "<|plamo:bos|>"};
        for (int position = count; position < 8192; ++position) {
            if (cancel(data)) return 2;
            auto token = llama_sampler_sample(sampler.get(), engine->context, -1);
            if (llama_vocab_is_eog(vocab, token)) return finish(pending.empty() || emit(pending.data(), pending.size(), data) ? 0 : 2);
            char piece[256];
            int size = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, true);
            if (size < 0) {
                std::vector<char> large(-size);
                size = llama_token_to_piece(vocab, token, large.data(), large.size(), 0, true);
                if (size < 0) return 3;
                pending.append(large.data(), size);
            } else pending.append(piece, size);
            size_t keep = 0;
            for (const auto & stop : stops) {
                auto at = pending.find(stop);
                if (at != std::string::npos) return finish(at == 0 || emit(pending.data(), at, data) ? 0 : 2);
                for (size_t n = 1; n < stop.size() && n <= pending.size(); ++n)
                    if (pending.compare(pending.size() - n, n, stop, 0, n) == 0) keep = std::max(keep, n);
            }
            const auto ready = pending.size() - keep;
            if (ready && !emit(pending.data(), ready, data)) return 2;
            pending.erase(0, ready);
            auto batch = llama_batch_get_one(&token, 1);
            if (llama_decode(engine->context, batch)) return cancel(data) ? 2 : 3;
        }
        if (!pending.empty() && !emit(pending.data(), pending.size(), data)) return 2;
        return finish(1);
    } catch (...) { return 3; }
}
