import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

function schemaModel(id, name, properties, required = [], catalogCategories = []) {
  return {
    endpoint_id: id,
    catalogCategories,
    metadata: { display_name: name },
    openapi: {
      components: {
        schemas: {
          Input: { type: "object", properties, required },
        },
      },
      paths: {
        [`/${id}`]: {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Input" },
                },
              },
            },
          },
        },
      },
    },
  };
}

async function start(t, adapters) {
  const root = await mkdtemp(path.join(tmpdir(), "fal-audio-workspace-"));
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  return { address: await app.listen(), root };
}

async function eventually(assertion, timeout = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      return await assertion();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return assertion();
}

test("Audio catalog configures Text-to-Speech and Speech-to-Speech models from their schemas", async (t) => {
  let requestedCategories = [];
  const { address } = await start(t, {
    async listFalModels({ categories }) {
      requestedCategories = categories;
      return {
        models: [
          schemaModel(
            "fal-ai/minimax/voice-design",
            "MiniMax Voice Design",
            {
              prompt: {
                type: "string",
                description: "Voice description prompt for generating a personalized voice",
                maxLength: 2_000,
              },
              preview_text: {
                type: "string",
                description: "Text for audio preview",
                maxLength: 500,
              },
            },
            ["prompt", "preview_text"],
            ["text-to-speech"],
          ),
          schemaModel(
            "fal-ai/gemini-3.1-flash-tts",
            "Gemini 3.1 Flash TTS",
            {
              prompt: {
                type: "string",
                description: "The text to convert to speech",
                minLength: 1,
                maxLength: 50_000,
              },
              style_instructions: { type: "string", maxLength: 4_000 },
              voice: { type: "string", enum: ["Kore", "Puck"], default: "Kore" },
              language_code: {
                anyOf: [
                  {
                    type: "string",
                    enum: ["English (US)", "Japanese (Japan)"],
                  },
                  { type: "null" },
                ],
              },
              speakers: {
                anyOf: [
                  {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        voice: { type: "string" },
                        speaker_id: { type: "string" },
                      },
                      required: ["voice", "speaker_id"],
                    },
                    minItems: 2,
                    maxItems: 10,
                  },
                  { type: "null" },
                ],
              },
              temperature: {
                type: "number",
                minimum: 0,
                maximum: 2,
                default: 1,
              },
              output_format: {
                type: "string",
                enum: ["wav", "mp3", "ogg_opus"],
                default: "mp3",
              },
            },
            ["prompt"],
            ["text-to-speech"],
          ),
          schemaModel(
            "fal-ai/chatterbox/speech-to-speech",
            "Chatterbox Speech to Speech",
            {
              source_audio_url: { type: "string", description: "Source audio file" },
              target_voice_audio_url: { type: "string", description: "Target voice audio file" },
            },
            ["source_audio_url"],
            ["speech-to-speech"],
          ),
        ],
      };
    },
  });

  const response = await fetch(`${address}/api/models/audio`);
  const catalog = await response.json();

  assert.equal(response.status, 200);
  assert.equal(requestedCategories.includes("text-to-speech"), true);
  assert.equal(requestedCategories.includes("speech-to-speech"), true);
  assert.deepEqual(
    catalog.models.map(({ id, modes }) => ({ id, modes })),
    [
      {
        id: "fal-ai/chatterbox/speech-to-speech",
        modes: ["speech-to-speech"],
      },
      {
        id: "fal-ai/gemini-3.1-flash-tts",
        modes: ["text-to-speech"],
      },
      {
        id: "fal-ai/minimax/voice-design",
        modes: ["text-to-speech"],
      },
    ],
  );
  assert.deepEqual(
    catalog.models.find((model) => model.id === "fal-ai/minimax/voice-design")
      .parameterFields,
    [
      {
        name: "preview_text",
        label: "Preview text",
        description: "Text for audio preview",
        required: true,
        type: "string",
        control: "text",
        maxLength: 500,
      },
    ],
  );
  assert.deepEqual(
    catalog.models.find((model) => model.id === "fal-ai/minimax/voice-design").prompt,
    {
      name: "prompt",
      label: "Prompt",
      description: "Voice description prompt for generating a personalized voice",
      required: true,
      maxLength: 2_000,
    },
  );
  assert.deepEqual(
    catalog.models.find((model) => model.id === "fal-ai/gemini-3.1-flash-tts").prompt,
    {
      name: "prompt",
      label: "Prompt",
      description: "The text to convert to speech",
      required: true,
      minLength: 1,
      maxLength: 50_000,
    },
  );
  assert.deepEqual(
    catalog.models.find((model) => model.id === "fal-ai/gemini-3.1-flash-tts")
      .parameterFields,
    [
      {
        name: "style_instructions",
        label: "Style instructions",
        description: "",
        required: false,
        type: "string",
        control: "text",
        maxLength: 4_000,
      },
      {
        name: "voice",
        label: "Voice",
        description: "",
        required: false,
        type: "string",
        control: "select",
        options: ["Kore", "Puck"],
        default: "Kore",
      },
      {
        name: "language_code",
        label: "Language code",
        description: "",
        required: false,
        type: "string",
        control: "select",
        options: ["English (US)", "Japanese (Japan)"],
        nullable: true,
      },
      {
        name: "speakers",
        label: "Speakers",
        description: "",
        required: false,
        type: "array",
        control: "list",
        minItems: 2,
        maxItems: 10,
        nullable: true,
        item: {
          name: "item",
          label: "Item",
          description: "",
          required: true,
          type: "object",
          control: "group",
          fields: [
            {
              name: "voice",
              label: "Voice",
              description: "",
              required: true,
              type: "string",
              control: "text",
            },
            {
              name: "speaker_id",
              label: "Speaker id",
              description: "",
              required: true,
              type: "string",
              control: "text",
            },
          ],
        },
      },
      {
        name: "temperature",
        label: "Temperature",
        description: "",
        required: false,
        type: "number",
        control: "number",
        default: 1,
        minimum: 0,
        maximum: 2,
      },
      {
        name: "output_format",
        label: "Output format",
        description: "",
        required: false,
        type: "string",
        control: "select",
        options: ["wav", "mp3", "ogg_opus"],
        default: "mp3",
      },
    ],
  );
});

test("MiniMax Speech 2.8 HD exposes nested voice and audio settings as fine-grained controls", async (t) => {
  const { address } = await start(t, {
    async listFalModels() {
      return {
        models: [
          {
            endpoint_id: "fal-ai/minimax/speech-2.8-hd",
            catalogCategories: ["text-to-speech"],
            metadata: { display_name: "MiniMax Speech 2.8 HD" },
            openapi: {
              components: {
                schemas: {
                  Input: {
                    type: "object",
                    required: ["prompt"],
                    "x-fal-order-properties": [
                      "prompt",
                      "voice_setting",
                      "audio_setting",
                      "language_boost",
                      "output_format",
                      "pronunciation_dict",
                      "normalization_setting",
                      "voice_modify",
                    ],
                    properties: {
                      prompt: { type: "string", minLength: 1, maxLength: 10_000 },
                      voice_setting: {
                        $ref: "#/components/schemas/VoiceSetting",
                        default: {
                          voice_id: "Wise_Woman",
                          pitch: 0,
                          speed: 1,
                          english_normalization: false,
                          vol: 1,
                        },
                      },
                      audio_setting: { $ref: "#/components/schemas/AudioSetting" },
                      language_boost: {
                        anyOf: [
                          {
                            type: "string",
                            enum: [
                              "Chinese",
                              "Chinese,Yue",
                              "English",
                              "Arabic",
                              "Russian",
                              "Spanish",
                              "French",
                              "Portuguese",
                              "German",
                              "Turkish",
                              "Dutch",
                              "Ukrainian",
                              "Vietnamese",
                              "Indonesian",
                              "Japanese",
                              "Italian",
                              "Korean",
                              "Thai",
                              "Polish",
                              "Romanian",
                              "Greek",
                              "Czech",
                              "Finnish",
                              "Hindi",
                              "Bulgarian",
                              "Danish",
                              "Hebrew",
                              "Malay",
                              "Slovak",
                              "Swedish",
                              "Croatian",
                              "Hungarian",
                              "Norwegian",
                              "Slovenian",
                              "Catalan",
                              "Nynorsk",
                              "Afrikaans",
                              "auto",
                            ],
                          },
                          { type: "null" },
                        ],
                      },
                      output_format: {
                        type: "string",
                        enum: ["url", "hex"],
                        default: "hex",
                      },
                      pronunciation_dict: {
                        anyOf: [
                          { $ref: "#/components/schemas/PronunciationDict" },
                          { type: "null" },
                        ],
                      },
                      normalization_setting: {
                        $ref: "#/components/schemas/LoudnessNormalizationSetting",
                      },
                      voice_modify: {
                        anyOf: [
                          { $ref: "#/components/schemas/VoiceModify" },
                          { type: "null" },
                        ],
                      },
                    },
                  },
                  VoiceSetting: {
                    type: "object",
                    "x-fal-order-properties": [
                      "voice_id",
                      "speed",
                      "vol",
                      "pitch",
                      "emotion",
                      "english_normalization",
                    ],
                    properties: {
                      voice_id: { type: "string", default: "Wise_Woman" },
                      speed: { type: "number", minimum: 0.5, maximum: 2, default: 1 },
                      vol: { type: "number", minimum: 0.01, maximum: 10, default: 1 },
                      pitch: { type: "integer", minimum: -12, maximum: 12, default: 0 },
                      emotion: {
                        anyOf: [
                          {
                            type: "string",
                            enum: [
                              "happy",
                              "sad",
                              "angry",
                              "fearful",
                              "disgusted",
                              "surprised",
                              "neutral",
                            ],
                          },
                          { type: "null" },
                        ],
                      },
                      english_normalization: { type: "boolean", default: false },
                    },
                  },
                  AudioSetting: {
                    type: "object",
                    "x-fal-order-properties": ["sample_rate", "bitrate", "format", "channel"],
                    properties: {
                      sample_rate: {
                        type: "integer",
                        enum: [8000, 16000, 22050, 24000, 32000, 44100],
                        default: 32000,
                      },
                      bitrate: {
                        type: "integer",
                        enum: [32000, 64000, 128000, 256000],
                        default: 128000,
                      },
                      format: {
                        type: "string",
                        enum: ["mp3", "pcm", "flac"],
                        default: "mp3",
                      },
                      channel: {
                        type: "integer",
                        enum: [1, 2],
                        default: 1,
                      },
                    },
                  },
                  PronunciationDict: {
                    type: "object",
                    "x-fal-order-properties": ["tone_list"],
                    properties: {
                      tone_list: { type: "array", items: { type: "string" } },
                    },
                  },
                  LoudnessNormalizationSetting: {
                    type: "object",
                    "x-fal-order-properties": [
                      "enabled",
                      "target_loudness",
                      "target_range",
                      "target_peak",
                    ],
                    properties: {
                      enabled: { type: "boolean", default: true },
                      target_loudness: {
                        type: "number",
                        minimum: -70,
                        maximum: -10,
                        default: -18,
                      },
                      target_range: {
                        type: "number",
                        minimum: 0,
                        maximum: 20,
                        default: 8,
                      },
                      target_peak: {
                        type: "number",
                        minimum: -3,
                        maximum: 0,
                        default: -0.5,
                      },
                    },
                  },
                  VoiceModify: {
                    type: "object",
                    "x-fal-order-properties": ["pitch", "intensity", "timbre"],
                    properties: {
                      pitch: {
                        type: "integer",
                        minimum: -100,
                        maximum: 100,
                        default: 0,
                      },
                      intensity: {
                        type: "integer",
                        minimum: -100,
                        maximum: 100,
                        default: 0,
                      },
                      timbre: {
                        type: "integer",
                        minimum: -100,
                        maximum: 100,
                        default: 0,
                      },
                    },
                  },
                },
              },
              paths: {
                "/fal-ai/minimax/speech-2.8-hd": {
                  post: {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: { $ref: "#/components/schemas/Input" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      };
    },
  });

  const catalog = await fetch(`${address}/api/models/audio`).then((response) => response.json());
  const model = catalog.models.find(
    (candidate) => candidate.id === "fal-ai/minimax/speech-2.8-hd",
  );
  const parameter = (name) => model.parameterFields.find((field) => field.name === name);
  const child = (field, name) => field.fields.find((candidate) => candidate.name === name);
  const voiceSetting = parameter("voice_setting");
  const audioSetting = parameter("audio_setting");

  assert.deepEqual(model.prompt, {
    name: "prompt",
    label: "Prompt",
    description: "",
    required: true,
    minLength: 1,
    maxLength: 10_000,
  });
  assert.deepEqual(model.parameterFields.map((field) => field.name), [
    "voice_setting",
    "audio_setting",
    "language_boost",
    "output_format",
    "pronunciation_dict",
    "normalization_setting",
    "voice_modify",
  ]);

  assert.equal(voiceSetting.control, "group");
  assert.deepEqual(voiceSetting.default, {
    voice_id: "Wise_Woman",
    pitch: 0,
    speed: 1,
    english_normalization: false,
    vol: 1,
  });
  assert.deepEqual(
    voiceSetting.fields.map(({ name, control }) => ({ name, control })),
    [
      { name: "voice_id", control: "text" },
      { name: "speed", control: "number" },
      { name: "vol", control: "number" },
      { name: "pitch", control: "number" },
      { name: "emotion", control: "select" },
      { name: "english_normalization", control: "boolean" },
    ],
  );
  assert.deepEqual(
    {
      minimum: child(voiceSetting, "vol").minimum,
      maximum: child(voiceSetting, "vol").maximum,
      default: child(voiceSetting, "vol").default,
    },
    { minimum: 0.01, maximum: 10, default: 1 },
  );
  assert.deepEqual(
    {
      type: child(voiceSetting, "pitch").type,
      minimum: child(voiceSetting, "pitch").minimum,
      maximum: child(voiceSetting, "pitch").maximum,
      default: child(voiceSetting, "pitch").default,
    },
    { type: "integer", minimum: -12, maximum: 12, default: 0 },
  );
  assert.deepEqual(
    {
      nullable: child(voiceSetting, "emotion").nullable,
      options: child(voiceSetting, "emotion").options,
    },
    {
      nullable: true,
      options: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"],
    },
  );
  assert.equal(child(voiceSetting, "english_normalization").default, false);

  assert.equal(audioSetting.control, "group");
  assert.deepEqual(audioSetting.default, {
    sample_rate: 32000,
    bitrate: 128000,
    format: "mp3",
    channel: 1,
  });
  assert.deepEqual(
    audioSetting.fields.map(({ name, control }) => ({ name, control })),
    [
      { name: "sample_rate", control: "select" },
      { name: "bitrate", control: "select" },
      { name: "format", control: "select" },
      { name: "channel", control: "select" },
    ],
  );
  assert.deepEqual(
    {
      type: child(audioSetting, "sample_rate").type,
      options: child(audioSetting, "sample_rate").options,
      default: child(audioSetting, "sample_rate").default,
    },
    {
      type: "number",
      options: [8000, 16000, 22050, 24000, 32000, 44100],
      default: 32000,
    },
  );
  assert.deepEqual(
    {
      type: child(audioSetting, "bitrate").type,
      options: child(audioSetting, "bitrate").options,
      default: child(audioSetting, "bitrate").default,
    },
    { type: "number", options: [32000, 64000, 128000, 256000], default: 128000 },
  );
  assert.deepEqual(
    {
      type: child(audioSetting, "channel").type,
      options: child(audioSetting, "channel").options,
      default: child(audioSetting, "channel").default,
    },
    { type: "number", options: [1, 2], default: 1 },
  );

  const language = parameter("language_boost");
  assert.equal(language.control, "select");
  assert.equal(language.nullable, true);
  assert.deepEqual(language.options.slice(0, 4), ["Chinese", "Chinese,Yue", "English", "Arabic"]);
  assert.equal(language.options.at(-1), "auto");
  assert.deepEqual(
    {
      options: parameter("output_format").options,
      default: parameter("output_format").default,
    },
    { options: ["url", "hex"], default: "hex" },
  );

  const pronunciation = parameter("pronunciation_dict");
  const tones = child(pronunciation, "tone_list");
  assert.equal(pronunciation.control, "group");
  assert.equal(pronunciation.nullable, true);
  assert.equal(tones.control, "list");
  assert.deepEqual(
    { type: tones.item.type, control: tones.item.control },
    { type: "string", control: "text" },
  );

  const normalization = parameter("normalization_setting");
  assert.equal(normalization.control, "group");
  assert.deepEqual(normalization.default, {
    enabled: true,
    target_loudness: -18,
    target_range: 8,
    target_peak: -0.5,
  });
  assert.deepEqual(
    ["target_loudness", "target_range", "target_peak"].map((name) => ({
      name,
      minimum: child(normalization, name).minimum,
      maximum: child(normalization, name).maximum,
      default: child(normalization, name).default,
    })),
    [
      { name: "target_loudness", minimum: -70, maximum: -10, default: -18 },
      { name: "target_range", minimum: 0, maximum: 20, default: 8 },
      { name: "target_peak", minimum: -3, maximum: 0, default: -0.5 },
    ],
  );

  const voiceModify = parameter("voice_modify");
  assert.equal(voiceModify.control, "group");
  assert.equal(voiceModify.nullable, true);
  assert.deepEqual(voiceModify.default, { pitch: 0, intensity: 0, timbre: 0 });
  assert.deepEqual(
    voiceModify.fields.map(({ name, type, minimum, maximum, default: defaultValue }) => ({
      name,
      type,
      minimum,
      maximum,
      default: defaultValue,
    })),
    [
      { name: "pitch", type: "integer", minimum: -100, maximum: 100, default: 0 },
      { name: "intensity", type: "integer", minimum: -100, maximum: 100, default: 0 },
      { name: "timbre", type: "integer", minimum: -100, maximum: 100, default: 0 },
    ],
  );
});

test("Text-to-Speech Batch submits the selected model schema payload without a live fal request", async (t) => {
  const submissions = [];
  const { address } = await start(t, {
    async generateMedia({ endpoint, input, onState }) {
      submissions.push({ endpoint, input });
      onState({ state: "submitted", requestId: "mock-audio-request" });
      return {
        requestId: "mock-audio-request",
        data: {
          custom_voice_id: "mock-custom-voice",
          audio: { url: "https://local.test/voice-preview.mp3" },
        },
      };
    },
    async downloadMedia({ url }) {
      assert.equal(url, "https://local.test/voice-preview.mp3");
      return { bytes: Buffer.from("mock audio"), contentType: "audio/mpeg" };
    },
  });

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "audio",
      mode: "text-to-speech",
      model: "fal-ai/minimax/voice-design",
      prompt: "Warm documentary narrator with a gentle cadence",
      parameters: {
        preview_text: "Welcome to the audio workspace.",
      },
      quantity: 1,
      sourceFields: {},
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const batch = await response.json();

  assert.equal(response.status, 201);
  assert.equal(batch.type, "audio");
  assert.equal(batch.mode, "text-to-speech");
  await eventually(() => {
    assert.deepEqual(submissions, [
      {
        endpoint: "fal-ai/minimax/voice-design",
        input: {
          preview_text: "Welcome to the audio workspace.",
          prompt: "Warm documentary narrator with a gentle cadence",
        },
      },
    ]);
  });
});

test("Speech-to-Speech Batch maps a staged audio file to its exact schema field", async (t) => {
  const submissions = [];
  const { address } = await start(t, {
    async uploadMediaSource({ type }) {
      assert.equal(type, "audio/wav");
      return "https://local.test/uploaded-source.wav";
    },
    async generateMedia({ endpoint, input, onState }) {
      submissions.push({ endpoint, input });
      onState({ state: "submitted", requestId: "mock-speech-request" });
      return { data: { audio: { url: "https://local.test/converted.wav" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("converted"), contentType: "audio/wav" };
    },
  });
  const source = await fetch(`${address}/api/media-sources?name=source.wav`, {
    body: Buffer.from("source audio"),
    headers: { "content-type": "audio/wav" },
    method: "POST",
  }).then((response) => response.json());

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "audio",
      mode: "speech-to-speech",
      model: "fal-ai/chatterbox/speech-to-speech",
      parameters: {},
      quantity: 1,
      sourceFields: { source_audio_url: source.id },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 201);
  await eventually(() => {
    assert.deepEqual(submissions, [
      {
        endpoint: "fal-ai/chatterbox/speech-to-speech",
        input: { source_audio_url: "https://local.test/uploaded-source.wav" },
      },
    ]);
  });
});

test("returned Audio stays playable after it is kept and the workspace restarts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-audio-library-"));
  const submissions = [];
  const options = {
    adapters: {
      async generateMedia({ input, onState }) {
        submissions.push(input);
        onState({ state: "submitted", requestId: "mock-gemini-request" });
        return {
          requestId: "mock-gemini-request",
          data: { audio: { url: "https://local.test/gemini-speech.mp3" } },
        };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("playable audio bytes"), contentType: "audio/mpeg" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  };
  const first = await createWorkspaceServer(options);
  t.after(() => first.close());
  const firstAddress = await first.listen();
  const batch = await fetch(`${firstAddress}/api/batches`, {
    body: JSON.stringify({
      type: "audio",
      mode: "text-to-speech",
      model: "fal-ai/gemini-3.1-flash-tts",
      prompt: "Read this sentence warmly.",
      parameters: {
        voice: "Kore",
        speakers: [
          { voice: "Charon", speaker_id: "Host" },
          { voice: "Kore", speaker_id: "Guest" },
        ],
        temperature: 1,
        output_format: "mp3",
      },
      quantity: 1,
      sourceFields: {},
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const completed = await eventually(async () => {
    const payload = await fetch(`${firstAddress}/api/results?type=audio`).then((response) =>
      response.json(),
    );
    const result = payload.results.find((item) => item.id === batch.results[0].id);
    assert.equal(result?.state, "completed");
    return result;
  });
  assert.deepEqual(submissions, [
    {
      voice: "Kore",
      speakers: [
        { voice: "Charon", speaker_id: "Host" },
        { voice: "Kore", speaker_id: "Guest" },
      ],
      temperature: 1,
      output_format: "mp3",
      prompt: "Read this sentence warmly.",
    },
  ]);

  const preview = await fetch(`${firstAddress}${completed.fileUrl}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "audio/mpeg");
  assert.equal(await preview.text(), "playable audio bytes");
  const range = await fetch(`${firstAddress}${completed.fileUrl}`, {
    headers: { range: "bytes=0-7" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 0-7/20");
  assert.equal(await range.text(), "playable");
  const kept = await fetch(`${firstAddress}/api/results/${completed.id}/keep`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(kept.state, "kept");
  await first.close();

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const library = await fetch(`${secondAddress}/api/results?type=audio`).then((response) =>
    response.json(),
  );

  assert.equal(library.results.length, 1);
  assert.equal(library.results[0].model, "fal-ai/gemini-3.1-flash-tts");
  const restoredPreview = await fetch(`${secondAddress}${library.results[0].fileUrl}`);
  assert.equal(restoredPreview.headers.get("content-type"), "audio/mpeg");
  assert.equal(await restoredPreview.text(), "playable audio bytes");
});
