/* static */
int8_t PatternGenerator::swing_amount() {
  if (options_.swing && output_mode() == OUTPUT_MODE_DRUMS) {
    int8_t value = U8U8MulShift8(settings_.options.drums.randomness, 42 + 1);
    return (!(step_ & 2)) ? value : -value;
  } else {
    return 0;
  }
}


void PatternGenerator::Evaluate() {
  state_ = 0;
  pulse_duration_counter_ = 0;
  
  Random::Update();
  // Highest bits: clock and random bit.
  state_ |= 0x40;
  state_ |= Random::state() & 0x80;
  
  if (output_clock()) {
    state_ |= OUTPUT_BIT_CLOCK;
  }

  // Refresh only at step changes.
  if (pulse_ != 0) {
    return;
  }
  
  if (options_.output_mode == OUTPUT_MODE_EUCLIDEAN) {
    EvaluateEuclidean();
  } else {
    EvaluateDrums();
  }
}



const drum_map = [
  [ node_10, node_8, node_0, node_9, node_11 ],
  [ node_15, node_7, node_13, node_12, node_6 ],
  [ node_18, node_14, node_4, node_5, node_3 ],
  [ node_23, node_16, node_21, node_1, node_2 ],
  [ node_24, node_19, node_17, node_20, node_22 ],
];

function ReadDrumMap(
  uint8_t step,
  uint8_t instrument,
  uint8_t x,
  uint8_t y) {
uint8_t i = x >> 6;
uint8_t j = y >> 6;
const prog_uint8_t* a_map = drum_map[i][j];
const prog_uint8_t* b_map = drum_map[i + 1][j];
const prog_uint8_t* c_map = drum_map[i][j + 1];
const prog_uint8_t* d_map = drum_map[i + 1][j + 1];
uint8_t offset = (instrument * kStepsPerPattern) + step;
uint8_t a = pgm_read_byte(a_map + offset);
uint8_t b = pgm_read_byte(b_map + offset);
uint8_t c = pgm_read_byte(c_map + offset);
uint8_t d = pgm_read_byte(d_map + offset);
return U8Mix(U8Mix(a, b, x << 2), U8Mix(c, d, x << 2), y << 2);
}

function EvaluateDrums() {
  // At the beginning of a pattern, decide on perturbation levels.
  if (step_ == 0) {
    for (uint8_t i = 0; i < kNumParts; ++i) {
      uint8_t randomness = options_.swing
          ? 0 : settings_.options.drums.randomness >> 2;
          // https://forum.mutable-instruments.net/t/midipal-timer/4330/4
      part_perturbation_[i] = U8U8MulShift8(Random::GetByte(), randomness);
    }
  }
  
  uint8_t instrument_mask = 1;
  uint8_t x = settings_.options.drums.x;
  uint8_t y = settings_.options.drums.y;
  uint8_t accent_bits = 0;
  for (uint8_t i = 0; i < kNumParts; ++i) {
    uint8_t level = ReadDrumMap(step_, i, x, y);
    if (level < 255 - part_perturbation_[i]) {
      level += part_perturbation_[i];
    } else {
      // The sequencer from Anushri uses a weird clipping rule here. Comment
      // this line to reproduce its behavior.
      level = 255;
    }
    uint8_t threshold = ~settings_.density[i];
    if (level > threshold) {
      if (level > 192) {
        accent_bits |= instrument_mask;
      }
      state_ |= instrument_mask;
    }
    instrument_mask <<= 1;
  }
  if (output_clock()) {
    state_ |= accent_bits ? OUTPUT_BIT_COMMON : 0;
    state_ |= step_ == 0 ? OUTPUT_BIT_RESET : 0;
  } else {
    state_ |= accent_bits << 3;
  }
}

/* static */
void PatternGenerator::EvaluateEuclidean() {
  // Refresh only on sixteenth notes.
  if (step_ & 1) {
    return;
  }
  
  // Euclidean pattern generation
  uint8_t instrument_mask = 1;
  uint8_t reset_bits = 0;
  for (uint8_t i = 0; i < kNumParts; ++i) {
    uint8_t length = (settings_.options.euclidean_length[i] >> 3) + 1;
    uint8_t density = settings_.density[i] >> 3;
    uint16_t address = U8U8Mul(length - 1, 32) + density;
    while (euclidean_step_[i] >= length) {
      euclidean_step_[i] -= length;
    }
    uint32_t step_mask = 1L << static_cast<uint32_t>(euclidean_step_[i]);
    uint32_t pattern_bits = pgm_read_dword(lut_res_euclidean + address);
    if (pattern_bits & step_mask) {
      state_ |= instrument_mask;
    }
    if (euclidean_step_[i] == 0) {
      reset_bits |= instrument_mask;
    }
    instrument_mask <<= 1;
  }
  
  if (output_clock()) {
    state_ |= reset_bits ? OUTPUT_BIT_COMMON : 0;
    state_ |= (reset_bits == 0x07) ? OUTPUT_BIT_RESET : 0;
  } else {
    state_ |= reset_bits << 3;
  }
}


void ScanPots() {
  if (long_press_detected) {
    if (parameter == PARAMETER_NONE) {
      // Freeze pot values
      for (uint8_t i = 0; i < 8; ++i) {
        pot_values[i] = adc.Read8(i);
      }
      parameter = PARAMETER_WAITING;
    } else {
      parameter = PARAMETER_NONE;
      pattern_generator.SaveSettings();
    }
    long_press_detected = false;
  }
  
  if (parameter == PARAMETER_NONE) {
    uint8_t bpm = adc.Read8(ADC_CHANNEL_TEMPO);
    bpm = U8U8MulShift8(bpm, 220) + 20;
    if (bpm != clock.bpm() && !clock.locked()) {
      clock.Update(bpm, pattern_generator.clock_resolution());
    }
    PatternGeneratorSettings* settings = pattern_generator.mutable_settings();
    settings->options.drums.x = ~adc.Read8(ADC_CHANNEL_X_CV);
    settings->options.drums.y = ~adc.Read8(ADC_CHANNEL_Y_CV);
    settings->options.drums.randomness = ~adc.Read8(ADC_CHANNEL_RANDOMNESS_CV);
    settings->density[0] = ~adc.Read8(ADC_CHANNEL_BD_DENSITY_CV);
    settings->density[1] = ~adc.Read8(ADC_CHANNEL_SD_DENSITY_CV);
    settings->density[2] = ~adc.Read8(ADC_CHANNEL_HH_DENSITY_CV);
  } else {
    for (uint8_t i = 0; i < 8; ++i) {
      int16_t value = adc.Read8(i);
      int16_t delta = value - pot_values[i];
      if (delta < 0) {
        delta = -delta;
      }
      if (delta > 32) {
        pot_values[i] = value;
        switch (i) {
          case ADC_CHANNEL_BD_DENSITY_CV:
            parameter = PARAMETER_CLOCK_RESOLUTION;
            pattern_generator.set_clock_resolution((255 - value) >> 6);
            clock.Update(clock.bpm(), pattern_generator.clock_resolution());
            pattern_generator.Reset();
            break;
            
          case ADC_CHANNEL_SD_DENSITY_CV:
            parameter = PARAMETER_TAP_TEMPO;
            pattern_generator.set_tap_tempo(!(value & 0x80));
            if (!pattern_generator.tap_tempo()) {
              clock.Unlock();
            }
            break;

          case ADC_CHANNEL_HH_DENSITY_CV:
            parameter = PARAMETER_SWING;
            pattern_generator.set_swing(!(value & 0x80));
            break;

          case ADC_CHANNEL_X_CV:
            parameter = PARAMETER_OUTPUT_MODE;
            pattern_generator.set_output_mode(!(value & 0x80) ? 1 : 0);
            break;

          case ADC_CHANNEL_Y_CV:
            parameter = PARAMETER_GATE_MODE;
            pattern_generator.set_gate_mode(!(value & 0x80));
            break;

          case ADC_CHANNEL_RANDOMNESS_CV:
            parameter = PARAMETER_CLOCK_OUTPUT;
            pattern_generator.set_output_clock(!(value & 0x80));
            break;
        }
      }
    }
  }
}


void Init() {
  sei();
  UCSR0B = 0;
  
  leds.set_mode(DIGITAL_OUTPUT);
  inputs.set_mode(DIGITAL_INPUT);
  inputs.EnablePullUpResistors();
  
  clock.Init();
  adc.Init();
  adc.set_num_inputs(ADC_CHANNEL_LAST);
  Adc::set_reference(ADC_DEFAULT);
  Adc::set_alignment(ADC_LEFT_ALIGNED);
  pattern_generator.Init();
  shift_register.Init();
  midi.Init();

}