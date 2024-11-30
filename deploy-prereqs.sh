ansible-playbook \
	-i ansible/inventory \
	--private-key /Users/ananchev/.ssh/id_rsa_fed \
    --ask-vault-pass \
	ansible/pre-requisites.yml