const hourHand = document.getElementById("hour-hand");
const minuteHand = document.getElementById("minute-hand");
const secondHand = document.getElementById("second-hand");

// 現在時刻から各針の角度を計算してアナログ時計に反映する。
function updateAnalogClock() {
  const now = new Date();
  const hours = now.getHours() % 12;
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();

  const secondAngle = (seconds + milliseconds / 1000) * 6 - 90;
  const minuteAngle = (minutes + seconds / 60) * 6 - 90;
  const hourAngle = (hours + minutes / 60) * 30 - 90;

  hourHand.style.transform = `translateY(-50%) rotate(${hourAngle}deg)`;
  minuteHand.style.transform = `translateY(-50%) rotate(${minuteAngle}deg)`;
  secondHand.style.transform = `translateY(-50%) rotate(${secondAngle}deg)`;
}

updateAnalogClock();
setInterval(updateAnalogClock, 1000);
