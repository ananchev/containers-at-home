#!/bin/bash

echo "Refreshing Ignition"
ignition/butane --pretty --files-dir ignition/vm --strict ignition/vm/config.bu > ignition/vm/config.ign

echo "Instantiating the QEMU VM"
cp qemu/fedora-coreos-41.20241122.3.0-qemu.aarch64.qcow2 qemu/fedora-coreos.qcow2
# qemu/launch-with-screen.sh
screen -dmS run-coreos-qemu qemu/launch.sh
echo "Sleeping 30 seconds to let the VMs boot"
sleep 30



