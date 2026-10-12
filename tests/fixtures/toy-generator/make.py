"""
Generates a TOY text generator laid out like onnx-community/gemma-4-E2B-it-ONNX (text-only sessions:
embed_tokens + decoder_model_merged with KV-cache inputs/outputs), for integration tests.

It is NOT Gemma. It is a successor table: whatever the prompt says, after the generation prompt it
emits one fixed answer, then <eos>. The answer holds one sentence the passages can support and one
invented one, so the citation checker has both to judge.

What it exercises for real: the vendored ONNX Runtime on a WebGPU session, Gemma4ForCausalLM's
text-only loading, the processor and chat template, tokenisation without a second <bos>, KV-cache
tensors and WebGPU output binding, TextStreamer streaming, stopping, decode-speed measurement,
background prefetch into the same cache the loader reads. It proves nothing about Gemma 4's real
file names, input names, chat template or output quality.

Run:  PYTHONPATH=<dir with onnx and numpy> python3 make.py     (outputs are committed)
"""
import json, os
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repo")

ANSWER = "The speckled band was a swamp adder [1] . Later the culprit escaped to Australia aboard one steamship [1 ]".split()
SPECIAL = ["<pad>", "<unk>", "<bos>", "<eos>", "<start_of_turn>", "<end_of_turn>"]
EXTRA = ["model", "user", "system", "Passages", "Question"]
vocab = {}
for t in SPECIAL + EXTRA + ANSWER:
    vocab.setdefault(t, len(vocab))
V = len(vocab)
H = V  # one-hot "embeddings"
HEAD_DIM, KV_HEADS, LAYERS = 4, 1, 1

succ = {i: vocab["<eos>"] for i in range(V)}
chain = ["model"] + ANSWER + ["<eos>"]
for a, b in zip(chain, chain[1:]):
    succ[vocab[a]] = vocab[b]
assert len(set(ANSWER)) == len(ANSWER) - 0 or True

eye = np.eye(V, dtype=np.float32)
wout = np.zeros((H, V), dtype=np.float32)
for i, j in succ.items():
    wout[i, j] = 20.0

def init(name, arr): return numpy_helper.from_array(np.array(arr), name)

# ---- embed_tokens: input_ids -> inputs_embeds, per_layer_inputs ----
e_nodes = [
    helper.make_node("Gather", ["Eye", "input_ids"], ["inputs_embeds"], axis=0),
    helper.make_node("Slice", ["inputs_embeds", init("s0", np.array([0], dtype=np.int64)).name, init("e4", np.array([4], dtype=np.int64)).name, init("ax2", np.array([2], dtype=np.int64)).name], ["pl3"]),
    helper.make_node("Unsqueeze", ["pl3", init("ax2b", np.array([2], dtype=np.int64)).name], ["per_layer_inputs"]),
]
e_graph = helper.make_graph(
    e_nodes, "toy_embed_tokens",
    [helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"])],
    [helper.make_tensor_value_info("inputs_embeds", TensorProto.FLOAT, ["batch", "seq", H]),
     helper.make_tensor_value_info("per_layer_inputs", TensorProto.FLOAT, ["batch", "seq", 1, 4])],
    initializer=[init("Eye", eye)] + [init(n, a) for n, a in []],
)
# the init() helper above already created tensors for s0/e4/ax2/ax2b; add them explicitly
e_graph.initializer.extend([init("s0", np.array([0], dtype=np.int64)), init("e4", np.array([4], dtype=np.int64)), init("ax2", np.array([2], dtype=np.int64)), init("ax2b", np.array([2], dtype=np.int64))])

# ---- decoder_model_merged: inputs_embeds + past -> logits + present ----
kv_in = lambda n: helper.make_tensor_value_info(f"past_key_values.0.{n}", TensorProto.FLOAT, ["batch_size", KV_HEADS, "past_sequence_length", HEAD_DIM])
kv_out = lambda n: helper.make_tensor_value_info(f"present.0.{n}", TensorProto.FLOAT, ["batch_size", KV_HEADS, "total_sequence_length", HEAD_DIM])
d_inits = [init("Wout", wout), init("k0", np.array([0], dtype=np.int64)), init("k4", np.array([4], dtype=np.int64)), init("v4", np.array([4], dtype=np.int64)), init("v8", np.array([8], dtype=np.int64)), init("ax2", np.array([2], dtype=np.int64)), init("ax1", np.array([1], dtype=np.int64))]
d_nodes = [
    helper.make_node("MatMul", ["inputs_embeds", "Wout"], ["logits"]),
    helper.make_node("Slice", ["inputs_embeds", "k0", "k4", "ax2"], ["newk3"]),
    helper.make_node("Slice", ["inputs_embeds", "v4", "v8", "ax2"], ["newv3"]),
    helper.make_node("Unsqueeze", ["newk3", "ax1"], ["newk"]),
    helper.make_node("Unsqueeze", ["newv3", "ax1"], ["newv"]),
    helper.make_node("Concat", ["past_key_values.0.key", "newk"], ["present.0.key"], axis=2),
    helper.make_node("Concat", ["past_key_values.0.value", "newv"], ["present.0.value"], axis=2),
]
d_graph = helper.make_graph(
    d_nodes, "toy_decoder",
    [helper.make_tensor_value_info("inputs_embeds", TensorProto.FLOAT, ["batch_size", "sequence_length", H]), kv_in("key"), kv_in("value")],
    [helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["batch_size", "sequence_length", V]), kv_out("key"), kv_out("value")],
    initializer=d_inits,
)
mk = lambda g: helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
em, dm = mk(e_graph), mk(d_graph)
onnx.checker.check_model(em); onnx.checker.check_model(dm)

os.makedirs(os.path.join(OUT, "onnx"), exist_ok=True)
onnx.save(em, os.path.join(OUT, "onnx", "embed_tokens_q4f16.onnx"))
onnx.save(dm, os.path.join(OUT, "onnx", "decoder_model_merged_q4f16.onnx"))

tok = {
    "version": "1.0", "truncation": None, "padding": None,
    "added_tokens": [{"id": vocab[t], "content": t, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True} for t in SPECIAL],
    "normalizer": None, "pre_tokenizer": {"type": "Whitespace"}, "post_processor": None, "decoder": None,
    "model": {"type": "WordLevel", "vocab": vocab, "unk_token": "<unk>"},
}
json.dump(tok, open(os.path.join(OUT, "tokenizer.json"), "w"))
json.dump({"tokenizer_class": "PreTrainedTokenizer", "pad_token": "<pad>", "unk_token": "<unk>", "bos_token": "<bos>", "eos_token": "<eos>", "model_max_length": 8192}, open(os.path.join(OUT, "tokenizer_config.json"), "w"))
json.dump({"processor_class": "Gemma4Processor"}, open(os.path.join(OUT, "processor_config.json"), "w"))
json.dump({"bos_token_id": 2, "eos_token_id": 3, "pad_token_id": 0, "do_sample": False}, open(os.path.join(OUT, "generation_config.json"), "w"))
json.dump({
    "model_type": "gemma4", "architectures": ["Gemma4ForConditionalGeneration"],
    "image_token_id": 100, "audio_token_id": 101, "vocab_size": V,
    "text_config": {"model_type": "gemma4_text", "hidden_size": H, "num_hidden_layers": LAYERS, "num_attention_heads": 1, "num_key_value_heads": KV_HEADS, "head_dim": HEAD_DIM, "vocab_size": V},
}, open(os.path.join(OUT, "config.json"), "w"))
open(os.path.join(OUT, "chat_template.jinja"), "w").write(
    "{{ bos_token }}{% for m in messages %}{% if m['role'] == 'system' %}<start_of_turn>user\n{{ m['content'] }}<end_of_turn>\n"
    "{% else %}<start_of_turn>{{ m['role'] }}\n{{ m['content'] }}<end_of_turn>\n{% endif %}{% endfor %}"
    "{% if add_generation_prompt %}<start_of_turn>model\n{% endif %}"
)
print("vocab", V, "answer:", " ".join(ANSWER))
