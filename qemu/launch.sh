#!/bin/bash

sudo /opt/homebrew/bin/qemu-system-aarch64 \
  -serial file:/tmp/coreos.serial \
  -qmp unix:/tmp/coreos.sock,server,nowait \
  -accel hvf \
  -M virt \
  -cpu host \
  -smp 4 \
  -m 4096 \
  -drive file=qemu/edk2-aarch64-code.fd,if=pflash,format=raw,readonly=on \
  -drive file=qemu/edk2-arm-vars.fd,if=pflash,format=raw \
  -fw_cfg name=opt/com.coreos/config,file=ignition/config.ign \
  -drive file=qemu/fedora-coreos.qcow2 \
  -device qemu-xhci \
  -netdev vmnet-bridged,id=n1,ifname=en0 \
  -device virtio-net,netdev=n1,mac=52:54:00:ea:5c:19 \
  -name coreos \
  -nographic
