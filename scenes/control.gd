extends Control
##
##  Virtual joystick: returns a direction Vector2 you can read from other scripts
##

@export var radius: float = 64.0              # how far the stick can travel
var direction: Vector2 = Vector2.ZERO         # public – read this in Player.gd
var _dragging := false

func _ready() -> void:
	# Make sure the thumb starts centred on the base
	$Stick.position = $Base.position
	# Ensure this Control actually receives input
	mouse_filter = Control.MOUSE_FILTER_STOP   # same as “Mouse Filter = Stop” in inspector

func _gui_input(event: InputEvent) -> void:
	# ACCEPT *both* touch and mouse events so it works in editor & on mobile
	if event is InputEventScreenTouch or event is InputEventMouseButton:
		_dragging = event.pressed
		if not _dragging:
			direction = Vector2.ZERO
			$Stick.position = $Base.position
	elif event is InputEventScreenDrag or event is InputEventMouseMotion:
		# Only update while dragging
		if _dragging:
			_update_direction(event.position)

func _update_direction(pos: Vector2) -> void:
	var base_size: Vector2 = $Base.get_combined_minimum_size()
	var centre: Vector2 = $Base.global_position + base_size * 0.5
	var offset: Vector2 = pos - centre
	direction = offset.limit_length(radius) / radius
	$Stick.position = $Base.position + direction * radius
