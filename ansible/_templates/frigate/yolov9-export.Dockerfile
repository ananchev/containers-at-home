# Exports YOLOv9 to ONNX for Frigate's OpenVINO detector (model_type: yolo-generic).
# Based on the recipe in Frigate 0.18.2 docs (docs/data/object_detectors_models.yaml), with:
#   * the yolov9 repo pinned to a commit (main has been unchanged since 2024-06-10)
#   * CPU-only torch preinstalled: torch is only used here to convert the .pt weights to
#     ONNX (seconds, no GPU needed). Frigate never uses torch - it runs the .onnx with
#     OpenVINO on the iGPU. The default x86 torch wheel would pull ~2.5 GB of NVIDIA CUDA
#     libraries that unas cannot use; the CPU wheel is ~200 MB and exports the same model.
# Built by applications/frigate.yml with BuildKit:
#   docker buildx build --build-arg MODEL_SIZE=s --build-arg IMG_SIZE=320 \
#     --output type=local,dest=<model_cache> -f yolov9-export.Dockerfile <ctx>
# Output: /yolov9-<size>-<imgsize>.onnx (the only file in the final stage).
FROM python:3.11 AS build
RUN apt-get update && apt-get install --no-install-recommends -y cmake libgl1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.10.4 /uv /bin/
WORKDIR /yolov9
ADD https://github.com/WongKinYiu/yolov9.git#5b1ea9a8b3f0ffe4fe0e203ec6232d788bb3fcff .
RUN uv pip install --system torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN uv pip install --system -r requirements.txt
RUN uv pip install --system onnx==1.18.0 onnxruntime onnx-simplifier==0.4.* onnxscript
ARG MODEL_SIZE
ARG IMG_SIZE
ADD https://github.com/WongKinYiu/yolov9/releases/download/v0.1/yolov9-${MODEL_SIZE}-converted.pt yolov9-${MODEL_SIZE}.pt
RUN sed -i "s/ckpt = torch.load(attempt_download(w), map_location='cpu')/ckpt = torch.load(attempt_download(w), map_location='cpu', weights_only=False)/g" models/experimental.py
RUN python3 export.py --weights ./yolov9-${MODEL_SIZE}.pt --imgsz ${IMG_SIZE} --simplify --include onnx

FROM scratch
ARG MODEL_SIZE
ARG IMG_SIZE
COPY --from=build /yolov9/yolov9-${MODEL_SIZE}.onnx /yolov9-${MODEL_SIZE}-${IMG_SIZE}.onnx
