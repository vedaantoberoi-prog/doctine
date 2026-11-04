/**
 * Doctine · emergency-rule evaluation set.
 * expect: true  = the fixed rules must flag it (the AI then decides if it is happening now; urgency can't drop below emergency unless the AI says it's a general question)
 * expect: false = the rules must NOT flag it (the AI still judges urgency on its own)
 * These rules are a safety net, not complete emergency detection. Known gaps are listed at the bottom and checked
 * so that any change in behaviour is noticed.
 */
export const CASES = [
  // clear emergencies
  ["clear", "I have crushing chest pain and my left arm hurts", true],
  ["clear", "my father can't breathe properly", true],
  ["clear", "her face is drooping and her speech is slurred", true],
  ["clear", "he collapsed and is unconscious", true],
  ["clear", "my throat is closing after eating peanuts", true],
  ["clear", "I want to end my life", true],
  ["clear", "I've been cutting myself", true],
  ["clear", "she is vomiting blood", true],
  // ambiguous: flagged on purpose (the AI decides; we prefer a false alarm to a miss)
  ["ambiguous", "my chest feels a bit tight when I climb stairs", true],
  ["ambiguous", "I fainted this morning but feel okay now", true],
  ["ambiguous", "I had a seizure last year, is it okay to drive?", true],
  ["ambiguous", "cold sweat and pain in my jaw since an hour", true],
  // educational questions that mention emergency symptoms: flagged by the rules, then the AI is told to judge;
  // the endpoint only keeps "emergency" if the AI does not say it is a general question
  ["educational", "What are the signs of a heart attack?", true],
  ["educational", "What is a stroke?", true],
  ["educational", "How is chest pain from acidity different from heart pain?", true],
  // Hinglish / Hindi in Latin script
  ["hinglish", "seene mein dard ho raha hai aur paseena aa raha hai", true],
  ["hinglish", "papa ko saans lene mein dikkat ho rahi hai", true],
  ["hinglish", "woh behosh ho gaye", true],
  ["hinglish", "mujhe marna hai, jeena nahi chahta", true],
  ["hinglish", "bacche ko tez bukhar hai aur fits aa rahe hain", true],
  ["hinglish", "pet mein halka dard hai kal se", false],
  ["hinglish", "sar dard ho raha hai subah se", false],
  // children
  ["child", "my 2 year old has a high fever and is very sleepy and hard to wake", true],
  ["child", "my baby is 3 months old and has a fever", true],
  ["child", "my son swallowed some of my BP tablets", true],
  ["child", "my 5 year old has a runny nose", false],
  ["child", "how much water should a 10 year old drink?", false],
  // pregnancy
  ["pregnancy", "I'm 7 months pregnant and have bleeding", true],
  ["pregnancy", "I am pregnant and have a severe headache and blurry vision", true],
  ["pregnancy", "38 weeks pregnant and my water broke", true],
  ["pregnancy", "is it safe to eat papaya when pregnant?", false],
  // medicines
  ["medicine", "Can I take paracetamol with my blood pressure medicine?", false],
  ["medicine", "I missed my metformin dose, what should I do?", false],
  ["medicine", "I accidentally took 20 paracetamol tablets", true],
  ["medicine", "I took too many sleeping pills", true],
  ["medicine", "what is Pan-D used for?", false],
  // missing information: nothing alarming, the AI should ask a follow-up
  ["missing_info", "I feel unwell", false],
  ["missing_info", "I have a pain", false],
  ["missing_info", "my mother is not well since yesterday", false],
  // historical: past events. The rules flag them on purpose; the AI then says whether it is happening now
  // (current_emergency=false keeps urgency at the AI's level and adds a 112 line). See tests/functions.test.mjs.
  ["historical", "I had a heart attack 5 years ago, can I start jogging?", true],
  ["historical", "my mother had a stroke last year, what diet is good for her?", true],
  ["historical", "I used to self-harm as a teenager, I'm okay now", true],
  // more Hinglish
  ["hinglish", "papa ka mooh tedha ho gaya hai aur bol nahi pa rahe", true],
  ["hinglish", "dil mein dard ho raha hai", true],
  ["hinglish", "bacche ne kerosene pi liya", true],
  ["hinglish", "main pregnant hoon aur khoon aa raha hai", true],
  ["hinglish", "bachcha saans nahi le raha", true],
  ["hinglish", "khana khane ke baad acidity ho rahi hai", false],
  // stroke and cardiac
  ["stroke_cardiac", "suddenly can't speak properly and my right hand is weak", true],
  ["stroke_cardiac", "pain spreading from my chest to my left arm", true],
  // poisoning and overdose
  ["poison", "my child drank phenyl", true],
  ["poison", "he swallowed rat poison", true],
  ["poison", "took 15 sleeping tablets", true],
  // self-harm, including indirect wording
  ["self_harm", "I don't see any point in living anymore", true],
  ["self_harm", "everyone would be better off without me", true],
  ["self_harm", "main khudkushi karna chahta hoon", true],
  ["self_harm", "I feel sad sometimes after work", false],
  // ordinary
  ["ordinary", "How can I improve my sleep?", false],
  ["ordinary", "What is HbA1c?", false],
  ["ordinary", "I have a mild headache since morning", false],
  ["ordinary", "my brush strokes look uneven", false],
];

/* Known gaps: things a person might say in an emergency that the fixed rules do not catch.
   The AI is still instructed to treat these as emergencies, but there is no deterministic backstop. */
export const KNOWN_GAPS = [
  "my left arm is numb and I feel strange",          // no chest/jaw pain or sweating words
  "dil bahut tez dhadak raha hai aur chakkar aa raha hai",  // palpitations with dizziness, in Hinglish
  "நெஞ்சு வலி",                                       // other Indian languages and scripts are not covered
  "he's been very confused since he hit his head",   // head injury with confusion, without "head injury"
];
