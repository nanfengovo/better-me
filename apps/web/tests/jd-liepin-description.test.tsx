import assert from "node:assert/strict";
import test from "node:test";
import { isLiepinDescriptionHeading, isLiepinRequirementsHeading } from "../server/jd-liepin-description";

test("[46] requirements headings are exact visible labels independent from standalone duties", () => {
  for (const label of ["任职要求", "职位要求"]) {
    for (const value of [label, ` ${label} `, `${label}：`, `${label}:`, label.split("").join(" \n")]) {
      assert.equal(isLiepinRequirementsHeading(value), true, value);
      assert.equal(isLiepinDescriptionHeading(value), false, value);
    }
  }
});

test("[46] requirements classifier does not promote duties, addresses, recommendations or approximate labels", () => {
  for (const value of ["", "职位描述", "岗位职责", "职位介绍", "工作地址", "其他说明", "推荐职位要求", "任职要求详情", "任职要求::", "职位要求：：", "【任职要求】", "任职资格", "岗位要求", "Requirements", "任职要求。", "任职要求及福利"]) assert.equal(isLiepinRequirementsHeading(value), false, value);
});
