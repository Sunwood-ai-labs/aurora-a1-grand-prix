#!/usr/bin/env python3
"""
Offline check of how well Jev-Omni reads the road from game frames.
Run inside the Colab kernel where `classifier` is loaded, after uploading the frames made by
tools/collect_jev_eval.py:

  colab upload -s jev-racer frames.json /content/frames.json
  colab exec   -s jev-racer -f tools/eval_jev_prompts.py

Ground truth (steer_gt) comes from the course geometry and is used only for scoring.
"""
import base64
import collections
import itertools
import json

frames = json.load(open("/content/frames.json"))
LABELS = ["left", "straight", "right"]
SIX = ["Drive straight ahead at full throttle", "Steer left to follow the left curve", "Steer right to follow the right curve",
       "Brake and turn left into the sharp left corner", "Brake and turn right into the sharp right corner",
       "Brake hard because the car is about to leave the track"]
ROAD = ["The road curves to the left", "The road goes straight ahead", "The road curves to the right"]
STEER = ["Turn left", "Keep it straight", "Turn right"]


def score(state_fn, question, options, labels, perms, use_image=True):
    conf, ok = collections.Counter(), 0
    for f in frames:
        open("/content/ev.jpg", "wb").write(base64.b64decode(f["img"].split(",")[-1]))
        acc = collections.Counter()
        for p in perms:
            opts = [options[i] for i in p]
            img = {"media": "/content/ev.jpg", "modality": "image"} if use_image else {}
            r = classifier.predict(state=state_fn(f), question=question, options=opts, **img)  # noqa: F821
            for text, prob in r["probabilities"].items():
                acc[labels[options.index(text)]] += prob
        pred = max(acc, key=acc.get)
        conf[(f["steer_gt"], pred)] += 1
        ok += pred == f["steer_gt"]
    per = {g: f"{conf[(g, g)]}/{sum(v for (a, _), v in conf.items() if a == g)}" for g in LABELS}
    return round(ok / len(frames), 3), per


game_state = lambda f: f"cockpit camera view of your F1 race car on an asphalt circuit. Speed: {f['kmh']} km/h."
plain = lambda f: "Cockpit view from an F1 car."
one = [tuple(range(3))]
cyc = [(0, 1, 2), (1, 2, 0), (2, 0, 1)]
runs = {
    "6-way action (as in the game)": (game_state, "What should the driver do right now to stay on the track and drive fast?",
                                      SIX, ["straight", "left", "right", "left", "right", "straight"], [tuple(range(6))]),
    "steer 3-way": (game_state, "Which way should the driver turn the steering wheel to follow the road?", STEER, LABELS, one),
    "road 3-way": (plain, "Where does the road ahead go?", ROAD, LABELS, one),
    "road 3-way, reversed order": (plain, "Where does the road ahead go?", ROAD[::-1], LABELS[::-1], one),
    "road 3-way, avg over 3 orders": (plain, "Where does the road ahead go?", ROAD, LABELS, cyc),
    "steer 3-way, avg over 3 orders": (plain, "Which way should the driver turn the steering wheel to follow the road?", STEER, LABELS, cyc),
    "road 3-way, avg over 6 orders": (plain, "Where does the road ahead go?", ROAD, LABELS, list(itertools.permutations(range(3)))),
}
sensor_only = lambda f: f"You are driving an F1 race car on an asphalt circuit. Speed: {f['kmh']} km/h. {f['sensorText']}"
fusion = lambda f: f"cockpit camera view of your F1 race car on an asphalt circuit. Speed: {f['kmh']} km/h. {f['sensorText']}"
Q6 = "What should the driver do right now to stay on the track and drive fast?"
L6 = ["straight", "left", "right", "left", "right", "straight"]
Q3 = "Which way should the driver turn the steering wheel to follow the road?"
if "sensorText" in frames[0]:
    runs.update({
        "SENSOR only, 6-way": (sensor_only, Q6, SIX, L6, [tuple(range(6))], False),
        "SENSOR only, steer 3-way": (sensor_only, Q3, STEER, LABELS, one, False),
        "VISION+SENSOR, 6-way": (fusion, Q6, SIX, L6, [tuple(range(6))]),
        "VISION+SENSOR, steer 3-way": (fusion, Q3, STEER, LABELS, one),
    })
only = __import__("os").environ.get("EVAL_ONLY")
if only:
    runs = {k: v for k, v in runs.items() if only in k or k.startswith("6-way")}
print("frames by label:", dict(collections.Counter(f["steer_gt"] for f in frames)))
for name, args in runs.items():
    print(f"{name:34s}", *score(*args), flush=True)
