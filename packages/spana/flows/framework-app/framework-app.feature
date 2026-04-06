@e2e @framework-app @showcase
Feature: Framework app (BDD)

  @web @android @ios
  Scenario: Playground interactions work across platforms
    Given I navigate to "/playground"
    Then I should see the element "playground-title" within 10000ms
    And I should not see the element "playground-details-text"
    When I type "Hello BDD" into the "playground-input" field
    Then the element "playground-input-mirror" should have text "Hello BDD"
    When I double tap the "playground-double-tap" element
    Then the element "playground-double-tap-status" should have text "Detected"
    When I long press the "playground-long-press" element
    Then the element "playground-long-press-status" should have text "Activated"
    When I tap the "playground-toggle" element
    Then I should see the element "playground-details-text"
    When I scroll down
    And I scroll down
    And I scroll down
    Then I should see the element "playground-sentinel" within 10000ms
    And the element "playground-sentinel-text" should have text "Bottom Reached"
    When I take a screenshot named "playground-bdd"
