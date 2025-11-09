extends CharacterBody2D

@onready var anim: AnimatedSprite2D = $AnimatedSprite2D
@onready var joystick := get_node("/root/Main/Control/TouchControls")  # CanvasLayer: Control > TouchControls

@export var SPEED: float = 100.0
@export var attack_cooldown: float = 0.3

var _last_dir: Vector2 = Vector2.RIGHT
var _attack_timer: float = 0.0

func _physics_process(delta: float) -> void:
	_handle_input()
	_handle_attack(delta)
	move_and_slide()
	_update_animation()

# ──────────────── Handle Movement ────────────────
func _handle_input() -> void:
	var direction: Vector2 = joystick.direction

	# Fallback to keyboard input if joystick is idle
	if direction == Vector2.ZERO:
		direction = Input.get_vector("left", "right", "up", "down")

	if direction != Vector2.ZERO:
		_last_dir = direction
		velocity = direction.normalized() * SPEED
	else:
		velocity = Vector2.ZERO

# ──────────────── Handle Attacking ────────────────
func _handle_attack(delta: float) -> void:
	_attack_timer = max(_attack_timer - delta, 0.0)

	if _attack_timer == 0.0 and Input.is_action_just_pressed("attack"):
		_attack_timer = attack_cooldown
		_play_attack_animation()

func _play_attack_animation() -> void:
	if _last_dir.x < 0:
		anim.play("attack_left")
	else:
		anim.play("attack_right")

# ──────────────── Handle Animation ────────────────
func _update_animation() -> void:
	if _attack_timer > 0.0:
		return  # Don't override attack animation

	if velocity.x < 0:
		if anim.animation != "walk_left":
			anim.play("walk_left")
	elif velocity.x > 0:
		if anim.animation != "walk_right":
			anim.play("walk_right")
	elif velocity.length() > 0:
		# Vertical movement; use last horizontal direction
		if _last_dir.x < 0:
			if anim.animation != "walk_left":
				anim.play("walk_left")
		else:
			if anim.animation != "walk_right":
				anim.play("walk_right")
	else:
		if anim.animation != "idle":
			anim.play("idle")
