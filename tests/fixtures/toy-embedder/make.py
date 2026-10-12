"""
Generates a TOY embedding model laid out like a Hugging Face ONNX repo, for integration tests.

It is NOT EmbeddingGemma and has no semantic ability beyond a hand-written word list: each word maps
to a concept vector (synonyms share one), a text embeds as the mean of its word vectors, stopwords
and unknown words are zero. What it does exercise, for real: the vendored ONNX Runtime wasm, a WebGPU
session, Transformers.js loading config/tokenizer/processor/weights through its cache, our worker,
batching, output handling, normalisation and the startup check.

Input and output names follow what Transformers.js' EmbeddingGemma2Model.forward feeds the session
(input_ids, attention_mask, image_features, video_features, audio_features). The output name
'sentence_embedding' is our assumption about the real model, so the toy proves nothing about it.

Run:  PYTHONPATH=<dir with onnx and numpy> python3 make.py     (outputs are committed; CI does not need Python)
"""
import json, os, re
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repo")
DIM = 768
rng = np.random.default_rng(20261012)

STOP = set("the a an of and to in is was were it that for on with as by at from this be are or not but his her he she they we you i what which when where how did do does who kind near beside over into out up down than then there their its has have had will would can could may might one two three four five task search result query title text none".split())
GROUPS = [
    "detective investigator holmes sleuth",
    "footprints marks prints tracks",
    "window glass pane",
    "ground floor earth",
    "tax taxes filings quarterly returns accounts",
    "month deadline due monthly",
    "snake adder serpent reptile",
    "band ribbon speckled",
    "rope cord",
    "cab hansom carriage cart",
    "fog mist haze",
    "paid pounds wages",
    "league society",
    "copying copy writing",
    "baker bakery bread sourdough",
    "lighthouse beacon",
    "telescope lens observatory",
    "canal locks waterway",
    "tram train streetcar",
    "choir singers",
]
EXTRA = "later culprit escaped australia aboard steamship examined studied doctor roylott kept room trained climb bell returned ventilator waited outside street thick horse stamped cobbles driver wore heavy grey coat jabez wilson four week encyclopaedia britannica office closed after eight weeks red headed swamp deadly".split()

vocab = {"<pad>": 0, "<unk>": 1, "<bos>": 2, "<eos>": 3, "<|image|>": 4, "<|video|>": 5, "<|audio|>": 6}
concept_of = {}
concepts = []
for g in GROUPS:
    idx = len(concepts); concepts.append(idx)
    for w in g.split():
        concept_of[w] = idx
for w in EXTRA:
    if w not in concept_of and w not in STOP:
        concept_of[w] = len(concepts); concepts.append(len(concepts))

# Every word of the calibration set also gets a concept of its own, so tools/calibrate.html can run end to end.
import re
cal = json.load(open(os.path.join(os.path.dirname(OUT), "..", "..", "..", "tools", "calibration-set.json")))
text = json.dumps({k: v for k, v in cal.items() if k != "images" and not k.startswith("_")})
for w in re.findall(r"[a-z0-9']+", text.lower()):
    if w not in concept_of and w not in STOP and w not in ("id", "title", "text", "q", "p", "claim", "passages", "answerable", "supported", "unsupported", "unanswerable", "near", "far"):
        concept_of[w] = len(concepts); concepts.append(len(concepts))

words = sorted(set(list(concept_of) + list(STOP)) | {":", "|", ".", ",", "?", "!", "-"})
for w in words:
    vocab[w] = len(vocab)

cvec = rng.standard_normal((len(concepts), DIM)).astype(np.float32)
cvec /= np.linalg.norm(cvec, axis=1, keepdims=True)
table = np.zeros((len(vocab), DIM), dtype=np.float32)
for w, i in vocab.items():
    if w in concept_of:
        table[i] = cvec[concept_of[w]]

# ---- ONNX graph: mean of word vectors over attended tokens ----
nodes, inits = [], [numpy_helper.from_array(table, "Wemb")]
def const(name, arr):
    inits.append(numpy_helper.from_array(np.array(arr), name)); return name
nodes += [
    helper.make_node("Gather", ["Wemb", "input_ids"], ["emb"], axis=0),
    helper.make_node("Cast", ["attention_mask"], ["maskf"], to=TensorProto.FLOAT),
    helper.make_node("Unsqueeze", ["maskf", const("ax2", np.array([2], dtype=np.int64))], ["maskf3"]),
    helper.make_node("Mul", ["emb", "maskf3"], ["weighted"]),
    helper.make_node("ReduceSum", ["weighted", const("ax1", np.array([1], dtype=np.int64))], ["sumv"], keepdims=0),
    helper.make_node("ReduceSum", ["maskf", "ax1"], ["cnt"], keepdims=1),
    helper.make_node("Add", ["cnt", const("eps", np.array(1e-6, dtype=np.float32))], ["cnt2"]),
    helper.make_node("Div", ["sumv", "cnt2"], ["sentence_embedding"]),
]
inputs = [
    helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"]),
    helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"]),
    helper.make_tensor_value_info("image_features", TensorProto.FLOAT, ["n_img", DIM]),
    helper.make_tensor_value_info("video_features", TensorProto.FLOAT, ["n_vid", DIM]),
    helper.make_tensor_value_info("audio_features", TensorProto.FLOAT, ["n_aud", DIM]),
]
outputs = [helper.make_tensor_value_info("sentence_embedding", TensorProto.FLOAT, ["batch", DIM])]
graph = helper.make_graph(nodes, "toy_embedder", inputs, outputs, initializer=inits)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=8)
onnx.checker.check_model(model)

os.makedirs(os.path.join(OUT, "onnx"), exist_ok=True)
onnx.save(model, os.path.join(OUT, "onnx", "model_q4.onnx"))  # fp32 inside; the name is what the q4 dtype key asks for

tok = {
    "version": "1.0", "truncation": None, "padding": None,
    "added_tokens": [{"id": i, "content": t, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True} for t, i in vocab.items() if i < 7],
    "normalizer": {"type": "Lowercase"},
    "pre_tokenizer": {"type": "Whitespace"},
    "post_processor": None, "decoder": None,
    "model": {"type": "WordLevel", "vocab": vocab, "unk_token": "<unk>"},
}
json.dump(tok, open(os.path.join(OUT, "tokenizer.json"), "w"))
json.dump({
    "tokenizer_class": "PreTrainedTokenizer", "pad_token": "<pad>", "unk_token": "<unk>", "bos_token": "<bos>", "eos_token": "<eos>",
    "model_max_length": 8192, "image_token": "<|image|>", "video_token": "<|video|>", "audio_token": "<|audio|>",
    "boi_token": "<|image|>", "eoi_token": "<|image|>", "boa_token": "<|audio|>", "eoa_token": "<|audio|>",
}, open(os.path.join(OUT, "tokenizer_config.json"), "w"))
json.dump({"processor_class": "EmbeddingGemma2Processor"}, open(os.path.join(OUT, "processor_config.json"), "w"))
json.dump({
    "model_type": "embedding_gemma2", "architectures": ["EmbeddingGemma2Model"],
    "text_config": {"model_type": "gemma4_text", "hidden_size": DIM},
    "image_token_id": 4, "video_token_id": 5, "audio_token_id": 6,
}, open(os.path.join(OUT, "config.json"), "w"))
print("vocab", len(vocab), "concepts", len(concepts), "onnx bytes", os.path.getsize(os.path.join(OUT, "onnx", "model_q4.onnx")))
