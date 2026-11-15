#!/usr/bin/python
# -*- coding = utf-8 to enable reading by simple editors -*-
# Control of DDS238-1, Script for change of Comms Settings
# (C)2017 Toulon7559

# This script through the RS485-bus modifies the slave address and baudrate of 1 ('''one!''') selected DDS238-1ZN kWh-meter.
# The writing of the modification is aimed at register 15hex/21dec which controls the communication settings.
# This script as starting values requires the actual slave-address and baudrate of the selected DDS238-1ZN kWh-meter.
# [[Before]] running the script, the User has to set in the script the applicable actual settings and the desired, new settings.
# If not sure of the actual settings, then first apply the (separate) script for read-out in Broadcast mode.
# That script is also useful for check/confirmation after modification of the Comms settings.
# Debug is foreseen as option to read more details of the communication.
# Environment & testing: 
# this script has been developed & tested on a Raspberry with Linksprite RS485-shield. 
# Application is at own risk for the User: feedback is encouraged.

#========================================================
# DEPENDENCIES
#========================================================

import serial
import minimalmodbus

#========================================================
# SETTINGS
#========================================================

present_address = 1     # decimal value of slave adress
present_rate = 9600     # 9600, 4800, 2400, 1200
new_address = 5         # decimal value of slave address
new_rate = 1            # 1=9600, 2=4800, 3=2400, 4=1200

#========================================================
# RUNTIME
#========================================================

print ('Present address = {}'.format(present_address))
print ('Present rate = {}'.format(present_rate))
print ('New address = {}'.format(new_address))
print ('New rate = {}'.format(new_rate))
newcom = new_address*256 + new_rate
print ('Command = {}'.format(newcom))

# mac /dev/tty.usbserial-130
instrument = minimalmodbus.Instrument('/dev/ttyUSB0',present_address) # port name, slave address
instrument.serial.baudrate = present_rate
instrument.serial.timeout = 0.5
# instrument.debug = True
instrument.write_register(21,newcom)
