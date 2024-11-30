#!/bin/bash

ansible-playbook \
	-i ansible/inventory \
	--private-key /Users/ananchev/.ssh/id_rsa_fed \
	--ask-vault-pass \
    ansible/applications/energy-meters.yml