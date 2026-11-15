#!/usr/bin/python
# -*- coding = utf-8 to enable reading by simple editors -*-
# Control of DDS238-1ZN, Script for read-out of Comms Settings
# (C)2017 Toulon7559

# This script through the RS485-bus reads the broadcast address 00 of the DDS238-1ZN kWh-meter.
# The reading is aimed at register 15hex/21dec which controls communication settings.
# This script extracts the actual slave-address and baudrate of the DDS238-1ZN kWh-meter.
# Before running the script, the User has to set the expected speed of RS485-communication.
# If not sure, then it is 'try-and-error' with simple output:
# IF correct rate AND device connected, THEN you see information. Otherwise blank fields.
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

speed = 9600  
# 9600(=>setting1), 4800(=>setting2), 2400(=>setting3), 1200(=>setting4)

#========================================================
# RUNTIME
#========================================================

# mac /dev/tty.usbserial-130
instrument = minimalmodbus.Instrument('/dev/ttyUSB0',0) # port name, Broadcast slave address
instrument.serial.baudrate = speed
instrument.serial.timeout = 0.5
# instrument.debug = True
#print(instrument)
# print
#instrument.read_register(21,0)
Status = instrument.read_register(21,0)
print('Comms_value = {}'.format(Status))
a = Status.to_bytes(2, byteorder='big')
print(a)
addres = Status//256
print('=> DDS238_Status, Address  = {}'.format(addres))
rate = Status%256
print('=> DDS238_Status, Baudrate = {}'.format(rate))
