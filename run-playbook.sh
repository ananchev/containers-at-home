#!/bin/bash

# Check if a playbook file is supplied as an argument
if [ -z "$1" ]; then
  echo "Error: No playbook specified."
  echo "Usage: $0 playbook.yml"
  exit 1
fi

ansible-playbook \
    -i ansible/inventory \
    --private-key /Users/ananchev/.ssh/id_rsa_fed \
    --ask-vault-pass \
    "$1"