"""Prints input and output names/shapes of an ONNX file without loading its weights."""
import sys, onnx
m = onnx.load(sys.argv[1], load_external_data=False)
def d(v): return [x.dim_param or x.dim_value for x in v.type.tensor_type.shape.dim], onnx.TensorProto.DataType.Name(v.type.tensor_type.elem_type)
print(sys.argv[1])
print(" inputs :", {i.name: d(i) for i in m.graph.input})
print(" outputs:", {o.name: d(o) for o in m.graph.output})
