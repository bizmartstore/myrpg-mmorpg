extends Control

@export var radius: float = 64.0
var direction: Vector2 = Vector2.ZERO
var _dragging := false
var _center: Vector2 = Vector2.ZERO

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	_center = global_position + (size * 0.5)  # assume Control has a defined size

func _gui_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch or event is InputEventMouseButton:
		if get_global_rect().has_point(event.position):
			_dragging = event.pressed
			if not _dragging:
				direction = Vector2.ZERO
	elif event is InputEventScreenDrag or event is InputEventMouseMotion:
		if _dragging:
			_update_direction(event.position)

func _update_direction(pos: Vector2) -> void:
	var offset = pos - _center
	direction = offset.limit_length(radius) / radius
